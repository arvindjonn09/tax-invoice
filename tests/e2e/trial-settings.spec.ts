import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type Page, expect, test } from "@playwright/test";
import { createDatabaseClient } from "../../packages/database/src/index";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { isolatedTestConnection } from "../helpers/test-environment";

// #232 (S14, design §12): the trial page for each role and state.
test.skip(
  !process.env.JOBFLOW_ISOLATED_TEST_DATABASE,
  "Use pnpm test:e2e with an isolated database for trial tests",
);

const PASSWORD = "a long synthetic trial phrase";
type Db = ReturnType<typeof createDatabaseClient>;

const noViolations = async (page: Page) =>
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

async function signIn(page: Page, email: string) {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

const newUser = async (db: Db, label: string) => {
  const email = `trial-${label}-${randomUUID()}@jobflow.invalid`;
  const user = await createCredentialUser(db, {
    email,
    name: `Synthetic ${label}`,
    password: PASSWORD,
  });
  return { ...user, email };
};

/** An owner onboards, so the company is a real self-service trial. */
async function trialCompany(db: Db, page: Page) {
  const owner = await newUser(db, "owner");
  await signIn(page, owner.email);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Business name").fill("Trial Sparks");
  await page.getByLabel("No, not registered").check();
  await page.getByRole("button", { name: /Create my business/ }).click();
  await expect(page).not.toHaveURL(/\/onboarding$/, { timeout: 30_000 });
  const company = await db.company.findFirstOrThrow({
    where: { selfServiceOwnerId: owner.id },
  });
  return { owner, companyId: company.id };
}

async function member(
  db: Db,
  browser: Browser,
  companyId: string,
  ownerId: string,
  role: "manager" | "accountant" | "employee",
) {
  const user = await newUser(db, role);
  await db.membership.create({
    data: { companyId, userId: user.id, createdBy: ownerId, role },
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email);
  return { page, context };
}

test("an owner on a trial requests an extension, with every failure explained", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const db = createDatabaseClient(isolatedTestConnection());
  try {
    const { owner } = await trialCompany(db, page);
    await page.goto("/settings");
    await page
      .getByRole("link", { name: "Trial and extension requests" })
      .click();
    await expect(page).toHaveURL(/\/settings\/trial$/);
    const status = page.getByRole("region", { name: "Status" });
    await expect(status).toContainText("30 days remaining");
    await expect(status).toContainText("(Sydney time)");
    await expect(
      page.getByRole("region", { name: "Past requests", exact: true }),
    ).toContainText("No past requests.");
    await noViolations(page);

    // Throttled, unreachable and already-pending replies (S14 AC3, AC4).
    const send = page.getByRole("button", { name: "Request extension" });
    const alert = page.getByRole("alert").filter({ hasText: "You can" });
    await page.route("**/api/company/trial/extension-requests", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          code: "request_throttled",
          retryAfterSeconds: 7200,
        }),
      }),
    );
    await send.click();
    await expect(alert).toContainText(
      "You can send another request in 2 hours.",
    );
    await expect(alert).toContainText("You can also email");
    await expect(alert).toBeFocused();
    await page.unroute("**/api/company/trial/extension-requests");
    await page.route("**/api/company/trial/extension-requests", (route) =>
      route.abort("connectionfailed"),
    );
    await send.click();
    const failed = page
      .getByRole("alert")
      .filter({ hasText: "Something went wrong" });
    await expect(failed).toBeFocused();
    // Typing after an error keeps focus in the field (no refocus per key).
    const message = page.getByLabel("Message (optional)");
    await message.click();
    await message.pressSequentially("abc");
    await expect(message).toBeFocused();
    await expect(message).toHaveValue("abc");
    await page.unroute("**/api/company/trial/extension-requests");
    await page.route("**/api/company/trial/extension-requests", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ code: "request_pending" }),
          })
        : route.continue(),
    );
    await send.click();
    // A 409 re-renders from the server; nothing is pending, so the form stays.
    await expect(
      page.getByRole("alert").filter({ hasText: /You can|went wrong/ }),
    ).toHaveCount(0);
    await page.unroute("**/api/company/trial/extension-requests");

    // The live count, then a request sent from the keyboard.
    await message.fill("Synthetic: a few more weeks, please.");
    await expect(page.getByText("36 of 1000 characters")).toBeVisible();
    await send.focus();
    await page.keyboard.press("Enter");
    const sent = page.getByRole("status").filter({ hasText: "Request sent." });
    await expect(sent).toContainText("We'll email you when it's decided.");
    await expect(sent).toBeFocused();

    await page.reload();
    const request = page.getByRole("region", { name: "Request more time" });
    await expect(request).toContainText("Pending");
    await expect(page.getByLabel("Message (optional)")).toHaveCount(0);
    expect(
      await db.trialExtensionRequest.count({
        where: { requestedBy: owner.id },
      }),
    ).toBe(1);
  } finally {
    await db.$disconnect();
  }
});

test("past outcomes, other roles, read-only and unrestricted", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const db = createDatabaseClient(isolatedTestConnection());
  try {
    const { owner, companyId } = await trialCompany(db, page);
    const company = await db.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    // Decided requests need a deciding operator (the decision CHECK).
    const operator = await newUser(db, "operator");
    await db.platformOperator.create({
      data: {
        userId: operator.id,
        grantedReason: "Synthetic grant",
        grantedBy: "e2e",
      },
    });
    const decided = {
      companyId,
      requestedBy: owner.id,
      lastDayAtRequest: company.trialLastDay!,
      decidedBy: operator.id,
    };
    await db.trialExtensionRequest.create({
      data: {
        ...decided,
        status: "declined",
        decidedAt: new Date(Date.now() - 2 * 86_400_000),
        decisionNote: "Synthetic: <b>not</b> this time",
      },
    });
    await db.trialExtensionRequest.create({
      data: {
        ...decided,
        status: "approved",
        decidedAt: new Date(Date.now() - 86_400_000),
        extensionDays: 10,
        newLastDay: new Date("2027-01-15T00:00:00Z"),
        decisionNote: "PRIVATE-OPERATOR-NOTE",
      },
    });

    await page.goto("/settings/trial");
    const history = page.getByRole("region", {
      name: "Past requests",
      exact: true,
    });
    await expect(history).toContainText("Approved: extended to 15 Jan 2027");
    // The reason is text, never markup.
    await expect(history).toContainText(
      "Declined: Synthetic: <b>not</b> this time",
    );
    await expect(page.getByText("PRIVATE-OPERATOR-NOTE")).toHaveCount(0);
    expect(await page.content()).not.toContain("PRIVATE-OPERATOR-NOTE");
    const table = page.getByRole("region", { name: "Past requests table" });
    await table.focus();
    await expect(table).toBeFocused();
    await noViolations(page);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await noViolations(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    // A manager has no Settings page, so the indicator links here (§12).
    const manager = await member(db, browser, companyId, owner.id, "manager");
    const history404: string[] = [];
    manager.page.on("request", (r) => {
      if (r.url().includes("/api/company/trial/extension-requests"))
        history404.push(r.url());
    });
    await manager.page.goto("/dashboard");
    await manager.page.getByRole("link", { name: "Trial details" }).click();
    await expect(manager.page).toHaveURL(/\/settings\/trial$/);
    await expect(
      manager.page.getByRole("region", { name: "Status" }),
    ).toContainText("days remaining");
    await expect(
      manager.page.getByText("Only an owner can request more time."),
    ).toBeVisible();
    await expect(manager.page.getByLabel("Message (optional)")).toHaveCount(0);
    await expect(
      manager.page.getByRole("region", { name: "Past requests", exact: true }),
    ).toHaveCount(0);
    // The breadcrumb doesn't link to a Settings page they can't open.
    await expect(
      manager.page.getByRole("link", { name: "Settings" }),
    ).toHaveCount(0);
    expect(history404).toEqual([]);
    // A client-side visit: wait for the new page's title before axe.
    await expect(manager.page).toHaveTitle(/Trial/);
    await noViolations(manager.page);
    await manager.context.close();

    const accountant = await member(
      db,
      browser,
      companyId,
      owner.id,
      "accountant",
    );
    await accountant.page.goto("/settings/trial");
    await expect(
      accountant.page.getByText("Only an owner can request more time."),
    ).toBeVisible();
    await expect(
      accountant.page.getByRole("region", {
        name: "Past requests",
        exact: true,
      }),
    ).toHaveCount(0);
    await accountant.context.close();

    const employee = await member(db, browser, companyId, owner.id, "employee");
    expect((await employee.page.goto("/settings/trial"))?.status()).toBe(404);
    await employee.context.close();

    // Read-only: the owner can still ask for more time.
    await db.company.update({
      where: { id: companyId },
      data: {
        trialStartedAt: new Date("2019-12-01T00:00:00Z"),
        trialLastDay: new Date("2020-01-01T00:00:00Z"),
      },
    });
    await page.goto("/settings/trial");
    const status = page.getByRole("region", { name: "Status" });
    await expect(status).toContainText("Trial ended 1 Jan 2020 · Read-only");
    await expect(status).toContainText(
      "Read-only since 12:00 am on 2 Jan 2020",
    );
    await expect(page.getByLabel("Message (optional)")).toBeVisible();
    await noViolations(page);

    // Unrestricted: nothing to request.
    await db.company.update({
      where: { id: companyId },
      data: { accessMode: "unrestricted" },
    });
    await page.goto("/settings/trial");
    await expect(
      page.getByText("This company isn't on a trial."),
    ).toBeVisible();
    await expect(page.getByLabel("Message (optional)")).toHaveCount(0);
  } finally {
    await db.$disconnect();
  }
});
