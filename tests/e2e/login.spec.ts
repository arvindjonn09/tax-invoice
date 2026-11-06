import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { requireAccounts } from "./accounts";

test("sign-in page is labelled, keyboard reachable and accessible", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page).toHaveTitle("Sign in · JobFlow");
  await expect(
    page.getByRole("heading", { name: "Sign in to JobFlow" }),
  ).toBeVisible();
  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password");
  await expect(email).toHaveAttribute("autocomplete", "username");
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await page.keyboard.press("Tab");
  await expect(email).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

// #223 (S1): a signed-out deep link goes to sign-in and comes back after it.
test("a signed-out deep link signs in and returns to that page", async ({
  page,
}) => {
  const accounts = requireAccounts();
  const response = await page.goto("/customers?q=Sample");
  await expect(page).toHaveURL(/\/login\?next=%2Fcustomers%3Fq%3DSample$/);
  expect(response?.headers()["cache-control"]).not.toContain("public");
  // No app data, navigation or counts before sign-in.
  await expect(page.getByRole("navigation", { name: /main/i })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Create an account" }),
  ).toHaveAttribute("href", "/signup");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
  });
  await page.getByLabel("Email").fill(accounts.emails.owner);
  await page.getByLabel("Password").fill(accounts.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/customers\?q=Sample$/, { timeout: 30_000 });
  // Never cached: Next.js sends no-store for these force-dynamic pages (and
  // "private, no-cache, no-store, …" in a production build).
  const signedIn = await page.request.get("/customers");
  expect(signedIn.headers()["cache-control"]).toMatch(/no-store/);
  expect(signedIn.headers()["cache-control"]).not.toMatch(
    /public|max-age=[1-9]/,
  );
});

test("an off-site next falls back to home", async ({ page }) => {
  const accounts = requireAccounts();
  await page.goto("/login?next=%2F%2Fevil.example");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
  });
  await page.getByLabel("Email").fill(accounts.emails.owner);
  await page.getByLabel("Password").fill(accounts.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Home (an owner lands on the dashboard), never off-site.
  await expect(page).toHaveURL(
    /^http:\/\/(127\.0\.0\.1|localhost):\d+\/(home|dashboard)$/,
    {
      timeout: 30_000,
    },
  );
});
