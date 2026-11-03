import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function scrollThrough(page: Page) {
  // Trigger every scroll reveal, then wait for the longest effect to settle.
  for (const id of ["why", "how", "features", "gst", "trust", "faq", "cta"]) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(2200);
}

test("landing page explains JobFlow and links to sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/^JobFlow · Job management/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Know what every job really made.",
    }),
  ).toBeVisible();
  for (const name of [
    "Stop guessing which jobs make money",
    "From first call to final payment",
    "Everything a growing contractor needs",
    "GST stays out of your profit",
    "Your records, kept properly",
    "Questions, answered",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeAttached();
  }
  await expect(page.getByText("Implementation in progress")).toHaveCount(0);

  // Sample figures match the GST/profit fixture and are labelled illustrative.
  const sample = page.getByRole("figure", { name: /Illustrative figures/ });
  await expect(sample).toContainText("$2,500.00");
  await expect(sample).toContainText("$250.00");
  await expect(sample).toContainText("$2,750.00");
  await expect(sample).toContainText("$1,750.00");

  // No lodgement, payroll or live-sign-up claims.
  await expect(page.locator("footer")).toContainText(
    "JobFlow does not lodge with the ATO",
  );
  await expect(page.getByText(/coming soon/).first()).toBeVisible();

  const signIn = page
    .getByRole("banner")
    .getByRole("link", { name: "Sign in" });
  await expect(signIn).toHaveAttribute("href", "/login");
  await signIn.click();
  await expect(page).toHaveURL(/\/login$/);
});

test("FAQ answers open with the keyboard", async ({ page }) => {
  await page.goto("/");
  const summary = page.getByText("Does JobFlow lodge my BAS?");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/draft GST\/BAS summary \(G1, 1A and 1B\)/),
  ).toBeVisible();
});

test("reduced motion shows every section in its final state", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("#gst").scrollIntoViewIfNeeded();
  const bars = page.locator("[data-bar]");
  await expect(bars).toHaveCount(4);
  for (const bar of await bars.all()) {
    expect(await bar.evaluate((el) => getComputedStyle(el).transform)).toBe(
      "none",
    );
  }
  for (const step of await page.locator("[data-step]").all()) {
    expect(
      Number(await step.evaluate((el) => getComputedStyle(el).opacity)),
    ).toBe(1);
  }
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    test(`landing is accessible and reflows: ${theme} ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      await scrollThrough(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }
}
