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

test("a visitor signs up, sets a password from the email, then signs in", async ({
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
    await page.getByLabel(/I agree to the/).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Nobody has a password yet, so signing in can't work.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // The email was queued and sent (its payload is then erased), so open a
    // link from a fresh token the same way the email does.
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
    await page.goto(`/reset-password#token=${token}`);
    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm new password").fill(PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByRole("heading", { name: "Password changed" }),
    ).toBeVisible();
    // The token is removed from the address bar.
    expect(new URL(page.url()).hash).toBe("");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("link", { name: "Sign in" }).first().click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // A verified user without a company sets up their business (S5).
    await expect(page).toHaveURL(/\/onboarding$/);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByLabel("Business name").fill("Signup Sparks");
    await page.getByLabel("No, not registered").check();
    await page.getByRole("button", { name: /Create my business/ }).click();
    // /home sends a new Owner on to their dashboard.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("region", { name: "Free trial" }),
    ).toContainText("Free trial: 30 days left");
    const company = await db.company.findFirstOrThrow({
      where: { selfServiceOwnerId: user.id },
    });
    expect(company).toMatchObject({
      name: "Signup Sparks",
      accessMode: "trial",
    });
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
