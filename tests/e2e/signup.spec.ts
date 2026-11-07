import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createDatabaseClient } from "../../packages/database/src/index";
import { issueToken } from "../../apps/web/src/server/account/tokens";
import { isolatedTestConnection } from "../helpers/test-environment";

// #217/#218/#220/#224: sign up → verify → onboarding → trial.
test.skip(
  !process.env.JOBFLOW_ISOLATED_TEST_DATABASE,
  "Use pnpm test:e2e with an isolated database for sign-up tests",
);

const PASSWORD = "a long synthetic sign-up phrase";

test("a visitor signs up, is held at verification, then verifies", async ({
  page,
}) => {
  // Five pages compile on first visit in `next dev`; the flow is long.
  test.setTimeout(120_000);
  const db = createDatabaseClient(isolatedTestConnection());
  // A deliverable-looking address, so the reserved-domain exemption doesn't apply.
  const email = `signup-${randomUUID()}@example.com`;
  try {
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Sam Sample");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByLabel(/I agree to the/).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Signing in before verifying only reaches the verify page.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/verify-email\/pending$/);
    await expect(page.getByText(email)).toBeVisible();
    await page.goto("/customers");
    await expect(page).toHaveURL(/\/verify-email\/pending$/);

    // The verification email was queued and sent (its payload is then
    // erased), so open a link from a fresh token the same way the email does.
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await expect
      .poll(
        async () =>
          (
            await db.emailOutbox.findFirst({
              where: { userId: user.id, kind: "verify_email" },
            })
          )?.status,
      )
      .toBe("sent");
    const token = await db.$transaction((tx) =>
      issueToken(tx, user.id, "email_verification"),
    );
    await page.goto(`/verify-email#token=${token}`);
    // Loading the link spends nothing; only the button does.
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(
      page.getByRole("heading", { name: "Email verified" }),
    ).toBeVisible();
    // The token is removed from the address bar.
    expect(new URL(page.url()).hash).toBe("");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("link", { name: "Continue" }).click();

    // A verified user without a company sets up their business (S5).
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByText("Step 1 of 2")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    // Usable at 320 px without sideways scrolling (#225).
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    // GST fields appear only once the answer is yes.
    await expect(page.getByLabel("GST accounting basis")).toHaveCount(0);
    await page.getByLabel("Yes, I'm registered for GST").check();
    await expect(page.getByLabel("GST accounting basis")).toBeVisible();
    await page.getByLabel("Business name").fill("Signup Sparks");
    await page.getByLabel("No, not registered").check();
    await expect(page.getByLabel("GST accounting basis")).toHaveCount(0);
    // Nothing is kept in the browser before submitting (S5 AC8).
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    // A double click still creates one company (one key per form load).
    await page.getByRole("button", { name: /Create my business/ }).dblclick();

    // Step 2: add the optional details or skip them (S5 AC8).
    await expect(page).toHaveURL(/\/onboarding\/details$/);
    await expect(page.getByText("Step 2 of 2")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await db.company.count({ where: { selfServiceOwnerId: user.id } }),
    ).toBe(1);
    await page.getByRole("link", { name: "Skip for now" }).click();
    // /home sends a new Owner on to their dashboard.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("status", { name: "Trial status" })).toHaveText(
      /30 days remaining/,
    );
    const company = await db.company.findFirstOrThrow({
      where: { selfServiceOwnerId: user.id },
    });
    expect(company).toMatchObject({
      name: "Signup Sparks",
      accessMode: "trial",
    });

    // What's left to set up, until it's dismissed (S5 AC8, design §10).
    const checklist = page.getByRole("region", {
      name: "Finish setting up your company",
    });
    await expect(checklist).toContainText("Business address");
    await expect(checklist).toContainText("To do");
    await expect(
      checklist.getByRole("link", { name: "Add business address" }),
    ).toHaveAttribute("href", "/settings");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await checklist.getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Enter");
    await expect(checklist).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeFocused();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Dashboard" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Finish setting up your company" }),
    ).toHaveCount(0);

    // #233: three days left, so the owner sees a one-time notice.
    const lastDay = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await db.company.update({
      where: { id: company.id },
      data: {
        trialLastDay: new Date(lastDay.toISOString().slice(0, 10)),
      },
    });
    await page.reload();
    const notice = page
      .getByRole("status")
      .filter({ hasText: "left in your trial" });
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(notice).toBeHidden();

    // No longer an active member of the company they created: the
    // self-service limit applies, with the support address (S5 AC5).
    await db.membership.updateMany({
      where: { companyId: company.id, userId: user.id },
      data: { isActive: false },
    });
    await page.goto("/onboarding");
    await page.getByLabel("Business name").fill("Second Sparks");
    await page.getByLabel("No, not registered").check();
    await page.getByRole("button", { name: /Create my business/ }).click();
    await expect(
      page.getByRole("heading", { name: "You've already set up a company" }),
    ).toBeFocused();
    await expect(
      page.getByText(/Contact us to set up another company/),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /@/ })).toHaveAttribute(
      "href",
      /^mailto:/,
    );
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});

// #224 (S4): forgot password → emailed link → choose a new password.
test("forgot password, then reset with the emailed link", async ({ page }) => {
  test.setTimeout(120_000);
  const db = createDatabaseClient(isolatedTestConnection());
  const email = `reset-${randomUUID()}@example.com`;
  try {
    // An account to reset (signed up, unverified: a reset also verifies).
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Riley Reset");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByLabel(/I agree to the/).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await expect(
      page.getByText(`If an account exists for ${email}`),
    ).toBeVisible();
    // Never written to browser storage.
    expect(
      await page.evaluate(() => [
        JSON.stringify(localStorage),
        JSON.stringify(sessionStorage),
      ]),
    ).not.toContain(email);

    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await expect
      .poll(
        async () =>
          (
            await db.emailOutbox.findFirst({
              where: { userId: user.id, kind: "password_reset" },
            })
          )?.status,
      )
      .toBe("sent");
    const token = await db.$transaction((tx) =>
      issueToken(tx, user.id, "password_reset"),
    );
    const response = await page.goto(`/reset-password#token=${token}`);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(
      page.getByRole("heading", { name: "Choose a new password" }),
    ).toBeVisible();
    // The token is removed from the address bar.
    await expect.poll(() => new URL(page.url()).hash).toBe("");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const fresh = "another long synthetic reset phrase";
    await page.getByLabel("New password", { exact: true }).fill(fresh);
    await page.getByLabel("Confirm new password").fill("does not match at all");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByRole("heading", { name: "There's a problem" }),
    ).toBeFocused();
    await page.getByLabel("New password", { exact: true }).fill(fresh);
    await page.getByLabel("Confirm new password").fill(fresh);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByRole("heading", { name: "Password changed" }),
    ).toBeVisible();

    // The link works once. (Leave first: a hash-only change isn't a load.)
    await page.goto("/login");
    await page.goto(`/reset-password#token=${token}`);
    await page.getByLabel("New password", { exact: true }).fill(fresh);
    await page.getByLabel("Confirm new password").fill(fresh);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByRole("heading", {
        name: "This link is invalid or has expired",
      }),
    ).toBeVisible();

    // The new password signs in, and the reset verified the address.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(fresh);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 30_000 });
  } finally {
    await db.$disconnect();
  }
});

test("a reset link with no token offers a new one", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(
    page.getByRole("heading", { name: "This link is invalid or has expired" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Send a new link" }),
  ).toHaveAttribute("href", "/forgot-password");
});

test("a throttled reset works again after the wait, without a reload", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/account/password/reset", async (route) => {
    calls += 1;
    // First a 429 with a 1-second wait, then the real (invalid-token) answer.
    if (calls === 1)
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "retry-after": "1" },
        body: JSON.stringify({
          error: "Too many attempts. Try again later.",
          retryAfterSeconds: 1,
        }),
      });
    return route.continue();
  });
  await page.goto(`/reset-password#token=${"0".repeat(64)}`);
  const fresh = "another long synthetic reset phrase";
  await page.getByLabel("New password", { exact: true }).fill(fresh);
  await page.getByLabel("Confirm new password").fill(fresh);
  const change = page.getByRole("button", { name: "Change password" });
  await change.click();
  await expect(
    page.getByText("Too many attempts. You can try again in 1 minute."),
  ).toBeVisible();
  await expect(change).toBeDisabled();
  await expect(change).toBeEnabled({ timeout: 5_000 });
  await page.getByLabel("New password", { exact: true }).fill(fresh);
  await page.getByLabel("Confirm new password").fill(fresh);
  await change.click();
  await expect(
    page.getByRole("heading", { name: "This link is invalid or has expired" }),
  ).toBeVisible();
  expect(calls).toBe(2);
});
