import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createDatabaseClient } from "../../packages/database/src/index";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { isolatedTestConnection } from "../helpers/test-environment";

// Same optional-database contract as main's signed-in settings specs.
test.skip(
  !process.env.JOBFLOW_ISOLATED_TEST_DATABASE,
  "Use pnpm test:e2e with an isolated database for signed-in tests",
);

const PASSWORD = "synthetic browser test password";
let db: ReturnType<typeof createDatabaseClient>;
let ownerEmail = "";
let employeeEmail = "";
let companyId = "";
let ownerId = "";
let employeeId = "";
test.beforeAll(async () => {
  db = createDatabaseClient(isolatedTestConnection());
  const suffix = randomUUID();
  ownerEmail = `owner-${suffix}@jobflow.invalid`;
  employeeEmail = `employee-${suffix}@jobflow.invalid`;
  ownerId = (
    await createCredentialUser(db, {
      email: ownerEmail,
      name: "Browser Owner",
      password: PASSWORD,
    })
  ).id;
  employeeId = (
    await createCredentialUser(db, {
      email: employeeEmail,
      name: "Browser Employee",
      password: PASSWORD,
    })
  ).id;
  companyId = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.company.create({
      data: {
        id: companyId,
        name: "Synthetic Browser Company",
        isDemo: true,
        createdBy: ownerId,
      },
    });
    await tx.membership.create({
      data: { companyId, userId: ownerId, createdBy: ownerId, role: "owner" },
    });
    await tx.membership.create({
      data: {
        companyId,
        userId: employeeId,
        createdBy: ownerId,
        role: "employee",
      },
    });
  });
});
test.afterAll(async () => db?.$disconnect());
let loginIp = 0;
async function login(page: Page, email: string) {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${++loginIp}`,
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  const signedIn = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await signedIn).status()).toBe(200);
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 15000 });
}

test("owner invites, recipient joins, owner changes role and deactivates access", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await login(page, ownerEmail);
  await page.goto("/users");
  await expect(
    page.getByRole("heading", { name: "User access", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Demo Data" })).toBeVisible();
  const invitedEmail = `invite-${randomUUID()}@jobflow.invalid`;
  await page.getByLabel("Email (required)").fill(invitedEmail);
  await page.getByLabel("Invitation role").selectOption("manager");
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = page.getByLabel("Invitation link — shown only now");
  await expect(link).toBeVisible();
  const invitationUrl = await link.inputValue();
  const recipient = await browser.newContext();
  try {
    const joining = await recipient.newPage();
    await joining.goto(invitationUrl);
    await joining.getByLabel("Name (new accounts)").fill("Browser Joiner");
    await joining
      .getByLabel("Password (new accounts, 12–128 characters)")
      .fill(PASSWORD);
    await joining.getByRole("button", { name: "Accept invitation" }).click();
    await expect(
      joining.getByRole("heading", { name: "Invitation accepted" }),
    ).toBeVisible();
    await expect(joining).toHaveURL(/\/invite$/);
    await login(joining, invitedEmail);
    const newUser = await db.user.findUniqueOrThrow({
      where: { email: invitedEmail },
    });
    expect(
      await db.membership.findUnique({
        where: { companyId_userId: { companyId, userId: newUser.id } },
      }),
    ).toMatchObject({ role: "manager" });
    await page.reload();
    const card = page.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Browser Joiner", exact: true }),
    });
    await card.getByLabel("Role for Browser Joiner").selectOption("accountant");
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Save role" }).click();
    await expect(
      card.getByText("Active · Accountant", { exact: true }),
    ).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Deactivate access" }).click();
    await expect(
      card.getByText("Inactive · Accountant", { exact: true }),
    ).toBeVisible();
    await joining.goto("/users");
    await expect(joining).toHaveURL(/\/(login|account)$/);
    expect(await db.authSession.count({ where: { userId: newUser.id } })).toBe(
      0,
    );
  } finally {
    await recipient.close();
  }
});

for (const width of [390, 1440]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`user access supports keyboard and accessibility at ${width}px ${colorScheme}`, async ({
      page,
    }, testInfo) => {
      await login(page, ownerEmail);
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/users");
      await page.getByLabel("Appearance").selectOption(colorScheme);
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`(?:^| )${colorScheme}(?: |$)`),
      );
      await expect(
        page.getByRole("heading", { name: "Browser Owner", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(0);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByLabel("Email (required)").focus();
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("Invitation role")).toBeFocused();
      const screenshot = testInfo.outputPath(
        `users-${width}-${colorScheme}.png`,
      );
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach("User access", {
        path: screenshot,
        contentType: "image/png",
      });
    });
  }
}

test("employee cannot open the page or its API", async ({ page }) => {
  await login(page, employeeEmail);
  await page.goto("/users");
  await expect(
    page.getByRole("heading", { name: "User access", exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get("/api/users")).status()).toBe(403);
});

test("empty search, load error and retry states", async ({ page }) => {
  await login(page, ownerEmail);
  await page.goto("/users");
  await expect(
    page.getByRole("heading", { name: "Browser Owner", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Search names or emails")
    .fill("no-synthetic-person-matches-this");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("No members match this search. Try another name or email."),
  ).toBeVisible();
  await page.route("**/api/users?**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Failed" }),
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("alert").filter({ hasText: "Unable to load user access" }),
  ).toContainText("Unable to load user access");
  await page.unroute("**/api/users?**");
  await page.getByRole("button", { name: "Reload user access" }).click();
  await expect(
    page.getByRole("heading", { name: "Browser Owner", exact: true }),
  ).toBeVisible();
});

test("owner finds and revokes an invitation beyond the first 100", async ({
  page,
}) => {
  const now = Date.now();
  const run = randomUUID();
  const fixtures = Array.from({ length: 105 }, (_, index) => ({
    id: randomUUID(),
    companyId,
    createdBy: ownerId,
    email: `paged-${run}-${index}@jobflow.invalid`,
    role: "employee" as const,
    tokenHash:
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    createdAt: new Date(now - (index + 1) * 1000),
    expiresAt: new Date(now + 60000),
  }));
  await db.userInvitation.createMany({ data: fixtures });
  await login(page, ownerEmail);
  await page.goto("/users");
  const paging = page.getByRole("navigation", { name: "Invitation pages" });
  await paging.getByRole("button", { name: "Next invitations" }).click();
  const oldest = fixtures.at(-1)!;
  const row = page.getByRole("listitem").filter({ hasText: oldest.email });
  await expect(row).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Revoke invitation" }).click();
  await expect(row).toHaveCount(0);
  expect(
    (await db.userInvitation.findUniqueOrThrow({ where: { id: oldest.id } }))
      .revokedAt,
  ).not.toBeNull();
});
