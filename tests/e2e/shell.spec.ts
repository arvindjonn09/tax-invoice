import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("shell shows persistent Demo Data and preview banners, a skip link and one main", async ({
  page,
}) => {
  await page.goto("/design-system/shell?role=owner");
  await expect(page.getByRole("region", { name: "Demo Data" })).toContainText(
    "Synthetic demonstration records are present.",
  );
  await expect(
    page.getByRole("region", { name: "Design preview" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});

test("employee navigation hides financial modules", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/design-system/shell?role=employee");
  const nav = page.getByRole("navigation", { name: "Main" }).last();
  await expect(nav.getByRole("link", { name: "Jobs" })).toBeVisible();
  for (const hidden of ["Invoices", "Dashboard", "Reports", "Customers"]) {
    await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);
  }
});

test("desktop sidebar collapses to icons but keeps accessible names", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/design-system/shell?role=manager");
  const nav = page.getByRole("navigation", { name: "Main" }).last();
  await nav.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(
    nav.getByRole("button", { name: "Expand navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: "Jobs" })).toBeVisible();
});

test("mobile menu opens a modal drawer that closes on Escape and returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/design-system/shell?role=owner");
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  const drawer = page.getByRole("dialog", { name: "Main navigation" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Invoices" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();
});

for (const width of [360, 390, 768, 1024, 1440]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`shell is accessible without horizontal scroll at ${width}px (${colorScheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/design-system/shell?role=accountant");
      await expect(
        page.getByRole("heading", { level: 1, name: "Shell preview" }),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
