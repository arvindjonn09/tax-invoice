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
  } finally {
    await db.$disconnect();
  }
});
