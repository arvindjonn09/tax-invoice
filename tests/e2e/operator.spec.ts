import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { createDatabaseClient } from "../../packages/database/src/index";
import {
  createCredentialUser,
  hashPassword,
} from "../../apps/web/src/server/auth/credentials";
import { runOperatorCommand } from "../../apps/web/src/server/operator/cli-commands";
import { isolatedTestConnection } from "../helpers/test-environment";
import { totp } from "../helpers/totp";

// #232 (design §13): the operator area, end to end. The web server allowlists
// this one id (playwright.config.ts).
test.skip(
  !process.env.JOBFLOW_ISOLATED_TEST_DATABASE,
  "Use pnpm test:e2e with an isolated database for operator tests",
);

const OPERATOR_ID = "00000000-0000-4000-8000-00000000e2e0";
const OPERATOR_EMAIL = "operator-e2e@jobflow.invalid";
const PASSWORD = "a long synthetic operator phrase";

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
}

test("an operator reviews a request, changes a company and enrols TOTP", async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const db = createDatabaseClient(isolatedTestConnection());
  const company = `Operator Sparks ${randomUUID().slice(0, 8)}`;
  try {
    // A fresh operator each run (retries reuse the fixed id).
    await db.platformOperator.deleteMany({ where: { userId: OPERATOR_ID } });
    await db.twoFactor.deleteMany({ where: { userId: OPERATOR_ID } });
    await db.authSession.deleteMany({ where: { userId: OPERATOR_ID } });
    await db.authAccount.deleteMany({ where: { userId: OPERATOR_ID } });
    await db.user.deleteMany({ where: { id: OPERATOR_ID } });
    await db.user.create({
      data: {
        id: OPERATOR_ID,
        email: OPERATOR_EMAIL,
        name: "Synthetic Operator",
        emailVerified: true,
      },
    });
    await db.authAccount.create({
      data: {
        userId: OPERATOR_ID,
        accountId: OPERATOR_ID,
        providerId: "credential",
        password: await hashPassword(PASSWORD),
      },
    });
    await db.platformOperator.create({
      data: {
        userId: OPERATOR_ID,
        grantedReason: "Synthetic e2e grant",
        grantedBy: "e2e",
      },
    });

    // An owner on a trial asks for more time (another browser).
    const ownerEmail = `owner-${randomUUID()}@jobflow.invalid`;
    await createCredentialUser(db, {
      email: ownerEmail,
      name: "Olive Owner",
      password: PASSWORD,
    });
    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    await signIn(owner, ownerEmail);
    await expect(owner).toHaveURL(/\/onboarding/, { timeout: 30_000 });
    await owner.getByLabel("Business name").fill(company);
    await owner.getByLabel("No, not registered").check();
    await owner.getByRole("button", { name: /Create my business/ }).click();
    await expect(owner).not.toHaveURL(/\/onboarding$/, { timeout: 30_000 });
    const sent = await owner.evaluate(async () => {
      const response = await fetch("/api/company/trial/extension-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Synthetic:\nmore time, please" }),
      });
      return response.status;
    });
    expect(sent).toBe(201);
    // Owners never reach the operator area: the same 404 as a missing page.
    expect((await owner.goto("/operator"))?.status()).toBe(404);
    expect((await owner.goto("/operator/mfa"))?.status()).toBe(404);
    expect((await owner.goto("/operator/companies"))?.status()).toBe(404);
    const requestId = (
      await db.trialExtensionRequest.findFirstOrThrow({
        where: { company: { name: company } },
      })
    ).id;
    expect(
      (await owner.goto(`/operator/requests/${requestId}`))?.status(),
    ).toBe(404);
    await ownerContext.close();

    // Outside production, an unenrolled operator signs in with a password.
    await signIn(page, OPERATOR_EMAIL);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
    await page.goto("/operator");
    await expect(
      page.getByRole("heading", { level: 1, name: "Extension requests" }),
    ).toBeVisible();
    await expect(
      page.getByText("Operator area · actions are audited"),
    ).toBeVisible();
    await expect(page.getByText(OPERATOR_EMAIL)).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: company });
    await expect(row).toContainText("Olive Owner");
    await noViolations(page);
    await row.getByRole("link", { name: /Review/ }).click();

    // The request, then an approval through the confirm dialog.
    await expect(
      page.getByRole("heading", { level: 1, name: `Request from ${company}` }),
    ).toBeVisible();
    await expect(page.getByText("more time, please")).toBeVisible();
    await noViolations(page);
    await page.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByText("Enter a reason")).toBeVisible();
    const days = page.getByLabel("Extend by (days)");
    await days.fill("0");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Enter a whole number of days/)).toBeVisible();
    await days.fill("10");
    await expect(page.getByText(/New last day:/)).toBeVisible();
    await page.getByLabel("Note (optional)").fill("Synthetic operator note");
    await page.getByRole("button", { name: "Approve" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Extend ${company} to`);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await noViolations(page);
    await dialog.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Extended to /)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

    // Decided requests show the outcome and who decided.
    await page.goto("/operator?status=decided");
    const decided = page.getByRole("row").filter({ hasText: company });
    await expect(decided).toContainText("Approved");
    await expect(decided).toContainText(OPERATOR_EMAIL);

    // Companies: search, then a direct change refused on the client.
    await page.getByRole("link", { name: "Companies" }).click();
    await page.getByLabel("Company name").fill(company);
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("link", { name: company }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: company }),
    ).toBeVisible();
    await noViolations(page);
    await page.getByLabel("New last day").fill("2020-01-01");
    await page.getByRole("button", { name: "Extend trial" }).click();
    await expect(
      page.getByText("Choose a later day than the current last day"),
    ).toBeVisible();
    await expect(page.getByText("Enter a reason").first()).toBeVisible();
    await page.getByLabel("Unrestricted").check();
    await page.getByLabel("Reason").last().fill("Synthetic pilot customer");
    await page.getByRole("button", { name: "Change access" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Change access" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Access is now unrestricted.",
    );
    await expect(page.getByText("Unrestricted").first()).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });

    // TOTP enrolment: a wrong code, then the real one from the CLI.
    await page.goto("/operator/mfa");
    await expect(
      page.getByRole("heading", { name: "Set up two-factor authentication" }),
    ).toBeVisible();
    await noViolations(page);
    await page.getByLabel("Enrolment code").fill("not-a-code");
    await page.getByLabel("Your password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "That code is invalid or has expired." }),
    ).toBeVisible();
    const code = (
      await runOperatorCommand(
        db,
        "enrol-code",
        { user: OPERATOR_ID, by: "e2e", reset: false },
        { JOBFLOW_OPERATOR_USER_IDS: OPERATOR_ID, APP_ENV: "development" },
      )
    )
      .split("\n")
      .at(-1)!;
    await page.getByLabel("Enrolment code").fill(code);
    await page.getByLabel("Your password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeVisible();
    await noViolations(page);
    const key = (await page.locator("code.font-mono").innerText()).replace(
      /\s/g,
      "",
    );
    const uri = `otpauth://totp/JobFlow?secret=${key}`;
    await page.getByLabel("Enter the 6-digit code").fill(totp(uri));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(
      page.getByRole("heading", { name: "Step 3: Save your backup codes" }),
    ).toBeFocused();
    await expect(page.getByRole("button", { name: "Finish" })).toBeDisabled();
    const backupCode = (
      await page
        .getByRole("region", { name: /Step 3/ })
        .locator("li")
        .first()
        .innerText()
    ).trim();
    await page.getByLabel("I've saved these").check();
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(
      page.getByRole("heading", { name: "Two-factor authentication is on." }),
    ).toBeVisible();

    // Signing in again asks for the code on /login (design §13e).
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, OPERATOR_EMAIL);
    await expect(
      page.getByRole("heading", { name: "Enter your authentication code" }),
    ).toBeFocused();
    await noViolations(page);
    await page.getByLabel("Authentication code").fill("000 000");
    await expect(page.getByLabel("Authentication code")).toHaveValue("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    const wrong = page
      .getByRole("alert")
      .filter({ hasText: "That code didn't work." });
    await expect(wrong).toBeFocused();
    // Typing after an error keeps focus in the field (no refocus per key).
    const field = page.getByLabel("Authentication code");
    await field.click();
    await field.pressSequentially("12");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("12");
    // A fresh window, so the code isn't the one enrolment just used.
    const next = totp(uri, Date.now() + 30_000);
    await page.getByLabel("Authentication code").fill(next);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/operator$/, { timeout: 30_000 });

    // "Cancel and sign out" ends the half-signed-in session.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, OPERATOR_EMAIL);
    await expect(
      page.getByRole("heading", { name: "Enter your authentication code" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel and sign out" }).click();
    await expect(page.getByLabel("Password")).toBeVisible();
    // Signed out again: the operator area sends them to sign in.
    await page.goto("/operator");
    await expect(page).toHaveURL(/\/login\?next=%2Foperator/);

    // A backup code works once, instead of the app.
    await signIn(page, OPERATOR_EMAIL);
    await page
      .getByRole("button", { name: "Use a backup code instead" })
      .click();
    await page.getByLabel("Backup code").fill(backupCode);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/operator$/, { timeout: 30_000 });
  } finally {
    await db.$disconnect();
  }
});
