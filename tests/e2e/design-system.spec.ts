import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
const source = readFileSync("docs/design/design-system.md", "utf8")
  .split("<!-- contrast-pairs:start -->")[1]!
  .split("<!-- contrast-pairs:end -->")[0]!;
const tokenPairs = source
  .split("\n")
  .filter((line) => line.startsWith("|") && line.includes("#"))
  .map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
for (const theme of ["light", "dark"] as const) {
  for (const width of [360, 390, 768, 1024, 1440]) {
    test(`components, contrast and reflow: ${theme} ${width}px`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/design-system");
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      await expect(
        page.getByText("Design preview — not real data", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("$2,500.00 AUD", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("−$15.00 AUD", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Unavailable", { exact: true }),
      ).toBeVisible();
      for (const cells of tokenPairs) {
        const [foreground, background] = cells[0]!.split(" / ");
        const expected =
          theme === "light" ? [cells[1], cells[2]] : [cells[3], cells[4]];
        const actual = await page.evaluate(
          ([fg, bg]) => {
            const css = getComputedStyle(document.documentElement);
            return [
              css.getPropertyValue(`--${fg}`).trim(),
              css.getPropertyValue(`--${bg}`).trim(),
            ];
          },
          [foreground, background],
        );
        expect(
          actual.map((value) =>
            value.length === 4
              ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toUpperCase()
              : value.toUpperCase(),
          ),
        ).toEqual(expected);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
      const disabledColours = await page
        .getByRole("button", { name: "Issue invoice (sample)" })
        .evaluate((element) => {
          const style = getComputedStyle(element);
          const sample = document.createElement("span");
          sample.style.backgroundColor = "var(--muted)";
          sample.style.color = "var(--muted-foreground)";
          element.append(sample);
          const expected = getComputedStyle(sample);
          const result = [
            style.color,
            style.backgroundColor,
            expected.color,
            expected.backgroundColor,
          ];
          sample.remove();
          return result;
        });
      expect(disabledColours.slice(0, 2)).toEqual(disabledColours.slice(2));
      expect(errors).toEqual([]);
      await testInfo.attach(`components-${theme}-${width}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    });
  }
}
test("default light, persistent preference, live system changes and keyboard focus", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/design-system");
  const preference = page.getByLabel("Appearance", { exact: true });
  await expect(preference).toHaveValue("light");
  await expect(page.locator("html")).toHaveClass(/light/);
  await preference.selectOption("dark");
  await page.reload();
  await expect(preference).toHaveValue("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await preference.selectOption("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(preference).toHaveValue("system");
  await page.getByRole("link", { name: "Back to foundation" }).focus();
  await page.keyboard.press("Tab");
  await expect(preference).toBeFocused();
  expect(
    await preference.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    ),
  ).toBe("solid");
});
test("storage denial remains usable", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage blocked");
    };
  });
  await page.goto("/design-system");
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
});
test("forced colours, reduced motion and 200% text reflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/design-system");
  await page.addStyleTag({
    content: "html {font-size:200%} body {font-size:1rem;line-height:1.5} ",
  });
  await expect(
    page.getByRole("heading", { name: "Design system foundations" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("Geist is self-hosted with no external font requests", async ({
  page,
}) => {
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fonts.push(request.url());
  });
  await page.goto("/design-system");
  await page.evaluate(() => document.fonts.ready);
  expect(fonts.length).toBeGreaterThan(0);
  expect(
    fonts.every((url) => new URL(url).origin === new URL(page.url()).origin),
  ).toBe(true);
});
