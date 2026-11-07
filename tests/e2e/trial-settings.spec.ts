import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createDatabaseClient } from "../../packages/database/src/index";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { isolatedTestConnection } from "../helpers/test-environment";

// #232 (S14, design §12): an owner on a trial asks for more time.
test.skip(
  !process.env.JOBFLOW_ISOLATED_TEST_DATABASE,
  "Use pnpm test:e2e with an isolated database for trial tests",
);

const PASSWORD = "a long synthetic trial phrase";

test("an owner on a trial requests an extension once", async ({ page }) => {
  test.setTimeout(120_000);
  const db = createDatabaseClient(isolatedTestConnection());
  // The reserved test domain counts as verified outside production.
  const email = `trial-${randomUUID()}@jobflow.invalid`;
  try {
    await createCredentialUser(db, {
      email,
      name: "Tess Trial",
      password: PASSWORD,
    });
    await page.setExtraHTTPHeaders({
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
    });
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 });
    await page.getByLabel("Business name").fill("Trial Sparks");
    await page.getByLabel("No, not registered").check();
    await page.getByRole("button", { name: /Create my business/ }).click();
    await expect(page).not.toHaveURL(/\/onboarding$/, { timeout: 30_000 });

    await page.goto("/settings");
    await page
      .getByRole("link", { name: "Trial and extension requests" })
      .click();
    await expect(page).toHaveURL(/\/settings\/trial$/);
    const status = page.getByRole("region", { name: "Status" });
    await expect(status).toContainText("30 days remaining");
    await expect(status).toContainText("(Sydney time)");
    await expect(
      page.getByRole("region", { name: "Past requests" }),
    ).toContainText("No past requests.");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // The live count, then a request sent from the keyboard.
    const message = page.getByLabel("Message (optional)");
    await message.fill("Synthetic: a few more weeks, please.");
    await expect(page.getByText("36 of 1000 characters")).toBeVisible();
    await page.getByRole("button", { name: "Request extension" }).focus();
    await page.keyboard.press("Enter");
    const sent = page.getByRole("status").filter({ hasText: "Request sent." });
    await expect(sent).toContainText("We'll email you when it's decided.");
    await expect(sent).toBeFocused();

    // Reloaded, the request waits for a decision and there's no form.
    await page.reload();
    const request = page.getByRole("region", { name: "Request more time" });
    await expect(request).toContainText("Pending");
    await expect(request).toContainText("We'll email you when it's decided.");
    await expect(page.getByLabel("Message (optional)")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      await db.trialExtensionRequest.count({
        where: { requester: { user: { email } } },
      }),
    ).toBe(1);
  } finally {
    await db.$disconnect();
  }
});
