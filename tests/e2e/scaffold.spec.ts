import { expect, test } from "@playwright/test";
test("serves the placeholder and health endpoint", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A clear view of every job." }),
  ).toBeVisible();
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toEqual({
    status: "ok",
    service: "jobflow-web",
  });
});
