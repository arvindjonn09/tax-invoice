import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn, type E2eRole } from "./accounts";

// #60 accessibility and responsive audit: every screen each role can open,
// at phone and desktop widths, in light and dark. Each must load with one
// h1, a skip link to main content, no horizontal scrolling and no axe
// violations (WCAG 2.2 AA rules). Screen-specific interaction checks live in
// each feature's own spec; this sweep makes sure no screen is missed.
test.setTimeout(300_000);
test.beforeEach(() => {
  requireAccounts();
});

const SCREENS: Record<E2eRole, string[]> = {
  owner: [
    "/home",
    "/dashboard",
    "/jobs",
    "/customers",
    "/quotes",
    "/invoices",
    "/invoices/new",
    "/payments",
    "/payments?view=payments",
    "/payments?view=receipts",
    "/payments/bills/new",
    "/expenses",
    "/timesheets",
    "/employees",
    "/contractors",
    "/reports?view=profitability",
    "/reports?view=gst",
    "/reports?view=ageing",
    "/reports?view=cash",
    "/users",
    "/settings",
  ],
  accountant: ["/home", "/reports?view=gst", "/payments", "/invoices"],
  manager: ["/home", "/dashboard", "/jobs", "/timesheets", "/reports"],
  employee: ["/home", "/jobs", "/timesheets", "/expenses"],
  subcontractor: ["/home", "/offers", "/jobs"],
};
const WIDTHS = [360, 768, 1440] as const;

async function settled(page: Page) {
  // Client screens fetch after hydration: wait for loading text to go.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator('[role="status"]', { hasText: /Loading/ }))
    .toHaveCount(0, { timeout: 30_000 })
    .catch(() => undefined);
}

for (const role of Object.keys(SCREENS) as E2eRole[])
  test(`${role}: every screen passes axe and reflows`, async ({ page }) => {
    await signIn(page, role);
    const problems: string[] = [];
    for (const path of SCREENS[role]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await settled(page);
      await expect(
        page.getByRole("link", { name: /skip to (main )?content/i }),
        path,
      ).toHaveCount(1);
      await expect(page.locator("main"), path).toHaveCount(1);
      for (const theme of ["light", "dark"] as const) {
        await page.getByLabel("Appearance").selectOption(theme);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          if (overflow > 0)
            problems.push(
              `${path} ${theme} ${width}px: ${overflow}px overflow`,
            );
          const { violations } = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
            .analyze();
          for (const v of violations)
            problems.push(
              `${path} ${theme} ${width}px: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")}`,
            );
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByLabel("Appearance").selectOption("light");
    }
    // Keyboard: the first Tab reaches the skip link, which moves focus past
    // the navigation into the main content.
    await page.goto("/home");
    await settled(page);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: /skip to (main )?content/i }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate(
        () =>
          Boolean(document.activeElement?.closest("main")) ||
          location.hash.length > 1,
      ),
    ).toBe(true);
    expect(problems).toEqual([]);
  });

// Standalone pages outside the app shell: no navigation, so no skip link
// or appearance control; still one h1, one main, axe-clean and reflowing.
test("standalone account and sign-in pages pass axe and reflow", async ({
  page,
}) => {
  const problems: string[] = [];
  const check = async (path: string) => {
    expect((await page.goto(path))?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("main")).toHaveCount(1);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overflow > 0)
        problems.push(`${path} ${width}px: ${overflow}px overflow`);
      for (const v of (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations)
        problems.push(
          `${path} ${width}px: ${v.id} ${v.nodes[0]?.target.join(" ")}`,
        );
    }
  };
  await check("/login");
  await signIn(page, "employee");
  await check("/account");
  expect(problems).toEqual([]);
});
