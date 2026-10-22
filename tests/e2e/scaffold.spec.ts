import { expect, test } from "@playwright/test";

test("serves the placeholder and non-cacheable health endpoint", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("JobFlow");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-AU");
  await expect(
    page.getByRole("heading", { name: "A clear view of every job." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Implementation in progress" }),
  ).toBeVisible();
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toEqual({
    status: "ok",
    service: "jobflow-web",
  });
});

for (const width of [360, 390, 768, 1024, 1440]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`placeholder renders at ${width}px in ${colorScheme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await page.goto("/");
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(
        page.getByText("This is the application scaffold.", { exact: false }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
      await testInfo.attach(`home-${width}-${colorScheme}`, {
        body: await page.screenshot({ fullPage: true, animations: "disabled" }),
        contentType: "image/png",
      });
    });
  }
}

test("unknown paths show a real not-found page", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
});
