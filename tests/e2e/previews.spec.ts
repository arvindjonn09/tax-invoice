import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = [
  "/design-previews",
  "/design-previews/dashboard",
  "/design-previews/dashboard?state=loading",
  "/design-previews/dashboard?state=empty",
  "/design-previews/dashboard?state=error",
  "/design-previews/invoice-builder",
  "/design-previews/invoice-builder?specimen=mixed",
  "/design-previews/invoice-builder?specimen=unregistered",
];

for (const path of PAGES) {
  test(`${path} is labelled as a preview and has no enabled financial action`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(
      page.getByRole("region", { name: "Design preview" }),
    ).toContainText("Design preview — not real data");
    await expect(page.getByRole("region", { name: "Demo Data" })).toHaveCount(
      0,
    );
    for (const name of [
      /issue/i,
      /save draft/i,
      /preview pdf/i,
      /add line/i,
      /pay/i,
      /export/i,
    ]) {
      for (const button of await page.getByRole("button", { name }).all()) {
        await expect(button).toBeDisabled();
      }
    }
  });
}

test("dashboard shows the approved sample figures, with cash kept apart from profit", async ({
  page,
}) => {
  await page.goto("/design-previews/dashboard");
  const main = page.getByRole("main");
  await expect(main).toContainText("$2,500.00 AUD ex GST");
  await expect(main).toContainText("$1,050.00 AUD ex GST");
  await expect(main).toContainText("Margin 42%");
  await expect(main).toContainText("$665.00 AUD incl GST");
  await expect(main).toContainText("$335.00 AUD incl GST");
  await expect(main).toContainText("Cash movement, not profit");
  await expect(main).toContainText("$1,750.00 AUD incl GST");
  await expect(main).toContainText("$590.00 AUD incl GST");
  await expect(main).toContainText("Draft BAS/GST summary");
  await expect(main).toContainText("Not lodged");
});

test("invoice titles follow registration, with every requested field", async ({
  page,
}) => {
  await page.goto("/design-previews/invoice-builder");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Tax Invoice",
  );
  for (const label of [
    "Customer reference / PO number (optional)",
    "Service location (site address) (optional)",
  ]) {
    await expect(page.getByLabel(label)).toBeDisabled();
  }
  await expect(
    page.getByRole("columnheader", { name: "Unit", exact: true }),
  ).toBeVisible();
  await page.goto("/design-previews/invoice-builder?specimen=unregistered");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invoice");
  await expect(page.getByRole("main")).toContainText(
    "Not GST registered — no GST charged.",
  );
});

test("mobile total bar links to the full breakdown", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/design-previews/invoice-builder");
  const link = page.getByRole("link", { name: "View breakdown" });
  await expect(link).toBeVisible();
  await expect(
    page.getByText("Total $2,750.00 AUD incl GST").first(),
  ).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/#totals$/);
  await expect(page.getByRole("heading", { name: "Totals" })).toBeInViewport();
});

for (const width of [360, 390, 768, 1024, 1440]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`previews are accessible without page overflow at ${width}px (${colorScheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      for (const path of [
        "/design-previews/dashboard",
        "/design-previews/invoice-builder?specimen=mixed",
      ]) {
        await page.goto(path);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, path).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations, path).toEqual([]);
      }
    });
  }
}
