import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
