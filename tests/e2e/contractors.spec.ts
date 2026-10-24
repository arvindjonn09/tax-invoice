import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
import { syntheticAbn } from "../helpers/abn";
test.setTimeout(90_000);
test.beforeEach(() => {
  requireAccounts();
});
async function write<T>(
  page: Page,
  url: string,
  data: unknown,
  method = "POST",
): Promise<T> {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  expect(response.ok(), `${url}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
async function fixture(page: Page) {
  const name = `Synthetic contractor ${randomUUID().slice(0, 8)}`;
  const row = await write<{ id: string }>(page, "/api/contractors", { name });
  return { ...row, name };
}
test("manager creates, edits, offers work and inspects an immutable acceptance", async ({
  page,
}) => {
  await signIn(page, "manager");
  const suffix = randomUUID().slice(0, 8),
    name = `Synthetic UI contractor ${suffix}`;
  await page.goto("/contractors");
  await page
    .getByRole("button", { name: "Add contractor", exact: true })
    .click();
  await page.getByLabel("Contractor name *", { exact: true }).fill(name);
  await page
    .getByLabel("Email", { exact: true })
    .fill(`synthetic-${suffix}@example.test`);
  await page.getByLabel("ABN", { exact: true }).fill(syntheticAbn("135792468"));
  await page
    .getByLabel("Registered for GST", { exact: true })
    .selectOption("yes");
  await page
    .getByRole("button", { name: "Save contractor", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const id = page.url().split("/").at(-1)!;
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic offer customer ${suffix}`,
  });
  const job = await write<{ id: string; reference: string }>(
    page,
    "/api/jobs",
    { title: `Synthetic offer job ${suffix}`, customerId: customer.id },
  );
  await page.getByRole("button", { name: "Create offer", exact: true }).click();
  await page.getByLabel("Find job", { exact: true }).fill(suffix);
  await page.getByLabel("Job *", { exact: true }).selectOption(job.id);
  await page
    .getByLabel("Work scope *", { exact: true })
    .fill("Synthetic fixed-price installation\nRetain existing finish.");
  await page
    .getByLabel("Fixed price (AUD ex GST) *", { exact: true })
    .fill("900.01");
  await page.getByRole("button", { name: "Save offer", exact: true }).click();
  await expect(
    page.getByText("$990.01 AUD incl GST", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit offer", exact: true }).click();
  await page
    .getByLabel("Fixed price (AUD ex GST) *", { exact: true })
    .fill("900.00");
  await page.getByRole("button", { name: "Save offer", exact: true }).click();
  await expect(
    page.getByText("$990.00 AUD incl GST", { exact: true }),
  ).toBeVisible();
  // Link the synthetic subcontractor account via protected office APIs, then
  // accept via its own endpoint; the office UI must display that exact snapshot.
  await signIn(page, "owner");
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(requireAccounts().emails.subcontractor)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find(
    (row) => row.role === "subcontractor",
  )!.userId;
  await write(page, `/api/contractors/${id}`, { userId }, "PATCH");
  const detail = (await (
    await page.request.get(`/api/contractors/${id}`)
  ).json()) as { offers: { id: string }[] };
  await signIn(page, "subcontractor");
  await write(page, `/api/my/offers/${detail.offers[0]!.id}`, {
    decision: "accept",
    note: "Synthetic acceptance",
  });
  await signIn(page, "manager");
  await page.goto(`/contractors/${id}`);
  await expect(
    page.getByRole("heading", { name: "Accepted terms snapshot", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit offer", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit contractor", exact: true })
    .click();
  await page
    .getByLabel("Registered for GST", { exact: true })
    .selectOption("no");
  await page
    .getByRole("button", { name: "Save contractor", exact: true })
    .click();
  await expect(
    page.getByText("$990.00 AUD incl GST", { exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Release account link for other tests/suites.
  await write(page, `/api/contractors/${id}`, { userId: null }, "PATCH");
});
test("failed saves retain edits and archive requires confirmation", async ({
  page,
}) => {
  await signIn(page, "owner");
  const row = await fixture(page);
  await page.goto(`/contractors/${row.id}`);
  await page
    .getByRole("button", { name: "Edit contractor", exact: true })
    .click();
  await page
    .getByLabel("Contractor name *", { exact: true })
    .fill(`${row.name} edited`);
  await page.route(`**/api/contractors/${row.id}`, async (route) => {
    if (route.request().method() === "PATCH")
      await route.fulfill({ status: 500, json: { error: "Synthetic retry" } });
    else await route.continue();
  });
  await page
    .getByRole("button", { name: "Save contractor", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Synthetic retry" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Contractor name *", { exact: true }),
  ).toHaveValue(`${row.name} edited`);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("link", { name: "Back to contractors", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(row.id));
  await page.unroute(`**/api/contractors/${row.id}`);
  await page
    .getByRole("button", { name: "Save contractor", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `${row.name} edited`, exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Archive contractor", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Archive contractor", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Archive contractor", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore contractor", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create offer", exact: true }),
  ).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Restore contractor", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Archive contractor", exact: true }),
  ).toBeVisible();
});
test("directory states, mobile themes and role permissions", async ({
  page,
}, testInfo) => {
  await signIn(page, "owner");
  const row = await fixture(page);
  await page.goto("/contractors");
  await page
    .getByLabel("Search contractors", { exact: true })
    .fill("no-match-contractor-36");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching contractors", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search contractors", { exact: true }).fill(row.name);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("link", { name: row.name, exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Appearance").selectOption(theme);
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`contractors-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.route("**/api/contractors?**", (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/contractors?**");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("link", { name: row.name, exact: true }),
  ).toBeVisible();
  await signIn(page, "accountant");
  await page.goto(`/contractors/${row.id}`);
  await expect(
    page.getByRole("heading", { name: row.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit contractor", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create offer", exact: true }),
  ).toHaveCount(0);
  for (const role of ["employee", "subcontractor"] as const) {
    await signIn(page, role);
    const response = await page.goto(`/contractors/${row.id}`);
    expect(response?.status()).toBe(404);
    expect(
      (await page.request.get(`/api/contractors/${row.id}`)).status(),
    ).toBe(403);
  }
});

test("hourly offers validate terms and require confirmation to withdraw", async ({
  page,
}, testInfo) => {
  await signIn(page, "manager");
  const row = await fixture(page);
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic hourly customer ${row.id.slice(0, 8)}`,
  });
  const job = await write<{ id: string }>(page, "/api/jobs", {
    title: "Synthetic hourly job",
    customerId: customer.id,
  });
  await page.goto(`/contractors/${row.id}`);
  await page.getByRole("button", { name: "Create offer", exact: true }).click();
  await page
    .getByLabel("Find job", { exact: true })
    .fill("Synthetic hourly job");
  await page.getByLabel("Job *", { exact: true }).selectOption(job.id);
  await page
    .getByLabel("Work scope *", { exact: true })
    .fill("Synthetic hourly scope");
  await page.getByLabel("Rate type", { exact: true }).selectOption("hourly");
  await page
    .getByLabel("Hourly rate (AUD ex GST) *", { exact: true })
    .fill("100.001");
  await page.getByLabel("Estimated hours *", { exact: true }).fill("7.5");
  await page.getByRole("button", { name: "Save offer", exact: true }).click();
  await expect(
    page.getByText(
      "Enter a non-negative AUD amount with at most two decimal places.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByLabel("Hourly rate (AUD ex GST) *", { exact: true })
    .fill("100.00");
  await page.getByRole("button", { name: "Save offer", exact: true }).click();
  await expect(
    page.getByText("$750.00 AUD incl GST", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("contractor-offer-mobile.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Withdraw offer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit offer", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Withdraw offer", exact: true })
    .click();
  await expect(
    page.getByText("Offer withdrawn.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit offer", exact: true }),
  ).toHaveCount(0);
});
