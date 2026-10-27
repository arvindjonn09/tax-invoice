import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";

async function write<T>(page: Page, path: string, body: unknown): Promise<T> {
  const result = await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
  return result.body as T;
}

test("owner uses live dashboard filters and reaches an overdue invoice in one click", async ({
  page,
}, testInfo) => {
  requireAccounts();
  test.setTimeout(150_000);
  await signIn(page, "owner");
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
      new Date(),
    ),
  );
  const old = new Date(`${today}T00:00:00Z`);
  old.setUTCDate(old.getUTCDate() - 60);
  const issuedOn = old.toISOString().slice(0, 10),
    name = `Synthetic dashboard ${Date.now()}`;
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name,
  });
  const job = await write<{ id: string }>(page, "/api/jobs", {
    customerId: customer.id,
    title: name,
  });
  const draft = await write<{ id: string }>(page, "/api/invoices", {
    customerId: customer.id,
    jobId: job.id,
    dueOn: issuedOn,
    lines: [
      {
        description: "Synthetic dashboard work",
        quantity: "1",
        unitPriceCents: "250000",
        taxCode: "OUT_OF_SCOPE",
      },
    ],
  });
  const invoice = await write<{ reference: string }>(
    page,
    `/api/invoices/${draft.id}/issue`,
    { issueDate: issuedOn },
  );
  await page.goto("/dashboard");
  await page.getByLabel("From", { exact: true }).fill(issuedOn);
  await page.getByLabel("To", { exact: true }).fill(today);
  await page.getByLabel("Customer", { exact: true }).selectOption(customer.id);
  await page.getByLabel("Job", { exact: true }).selectOption(job.id);
  await page.getByRole("button", { name: "Show dashboard" }).click();
  await expect(
    page.getByText("Invoiced revenue", { exact: true }).locator(".."),
  ).toContainText("2,500.00");
  await expect(
    page.getByText("Customers owe", { exact: true }).locator(".."),
  ).toContainText("2,500.00");
  await expect(page.getByRole("region", { name: "Demo Data" })).toBeVisible();
  await expect(
    page.getByText("Draft BAS/GST summary — not lodged", { exact: true }),
  ).toBeVisible();
  for (const width of [360, 390, 768, 1024, 1440])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (width === 390 || width === 1440)
        await testInfo.attach(`dashboard-${width}-${theme}`, {
          body: await page.screenshot({
            fullPage: true,
            animations: "disabled",
          }),
          contentType: "image/png",
        });
    }
  await page.getByLabel("From", { exact: true }).fill(today);
  await page.getByLabel("To", { exact: true }).fill(issuedOn);
  await expect(
    page.getByRole("button", { name: "Show dashboard" }),
  ).toBeDisabled();
  await page.getByLabel("From", { exact: true }).fill(issuedOn);
  await page.getByLabel("To", { exact: true }).fill(today);
  // The invoice is directly reachable from the dashboard (one click).
  await page
    .getByRole("link", { name: `${invoice.reference} · ${name}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${draft.id}$`));
});

test("dashboard keeps GST and ledger figures away from managers and all figures away from workers", async ({
  page,
}) => {
  requireAccounts();
  test.setTimeout(150_000);
  for (const role of ["manager", "employee", "subcontractor"] as const) {
    await signIn(page, role);
    const response = await page.goto("/dashboard");
    if (role === "manager") {
      await expect(
        page.getByText("Invoiced revenue", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Customers owe", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("1A GST on sales", { exact: true }),
      ).toHaveCount(0);
    } else expect(response?.status()).toBe(404);
    const status = await page.evaluate(
      async () =>
        (await fetch("/api/dashboard?from=2026-01-01&to=2026-12-31")).status,
    );
    expect(status).toBe(role === "manager" ? 200 : 403);
  }
});

test("dashboard handles loading errors, retry and an empty range", async ({
  page,
}) => {
  requireAccounts();
  await signIn(page, "owner");
  await page.route("**/api/dashboard?**", (route) =>
    route.fulfill({ status: 500, json: { error: "Synthetic failure" } }),
  );
  await page.goto("/dashboard");
  await expect(
    page.getByRole("alert").filter({ hasText: "Couldn't load" }),
  ).toContainText("Couldn't load");
  await page.unroute("**/api/dashboard?**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Invoiced revenue", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill("2000-01-01");
  await page.getByLabel("To", { exact: true }).fill("2000-01-01");
  await page.getByRole("button", { name: "Show dashboard" }).click();
  await expect(
    page.getByText("Invoiced revenue", { exact: true }).locator(".."),
  ).toContainText("0.00");
  await expect(
    page.getByText("No overdue customer invoices for these filters.", {
      exact: true,
    }),
  ).toBeVisible();
});
