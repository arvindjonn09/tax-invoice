import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
import { syntheticAbn } from "../helpers/abn";
test.setTimeout(150_000);
test.beforeEach(() => {
  requireAccounts();
});

async function write<T>(
  page: Page,
  url: string,
  data: unknown,
  method = "POST",
) {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  expect(response.ok(), `${method} ${url}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

async function audit(page: Page, testInfo: TestInfo, name: string) {
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Appearance").selectOption(theme);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("Appearance").selectOption("light");
}

test("accountant records a bill, part-pays it and voids the payment", async ({
  page,
}, testInfo) => {
  await signIn(page, "accountant");
  const supplier = `Synthetic Hardware ${randomUUID().slice(0, 8)}`;
  await page.goto("/payments");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments");
  await expect(
    page.getByRole("heading", { name: "Supplier bills" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Record bill" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Record bill",
  );
  await page.getByLabel("Supplier name (required)").fill(supplier);
  await page
    .getByLabel("Supplier registered for GST? (required)")
    .selectOption("no");
  await page.getByLabel("Supplier's bill number").fill("SYN-1001");
  await page.getByLabel("Description (required)").fill("Synthetic timber");
  await page.getByLabel("GST treatment (required)").selectOption("GST_FREE");
  await page.getByLabel("Amount ex GST (required)").fill("330.00");
  await expect(page.getByRole("region", { name: "Bill total" })).toContainText(
    "$330.00 AUD",
  );
  await audit(page, testInfo, "bill-form");
  await page.getByRole("button", { name: "Record bill" }).click();

  await expect(page).toHaveURL(/\/payments\/bills\/[0-9a-f-]{36}/);
  await expect(page.getByText("Bill recorded.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Bill from ${supplier}`,
  );
  const owed = page.getByRole("region", { name: "Owed · AUD" });
  await expect(owed).toContainText("Still owing$330.00 AUD");
  await expect(
    page.getByRole("region", { name: "GST and job cost" }),
  ).toContainText("Job cost (ex GST + unclaimable GST)$330.00 AUD");
  const billUrl = page.url().replace(/\?.*$/, "");
  await audit(page, testInfo, "bill-detail");

  // Settlement: a payment preset to this bill, reduced to a part payment.
  await page.getByRole("link", { name: "Record payment" }).click();
  await expect(page.getByLabel("Paid to (required)")).toHaveValue(/.+/);
  const amount = page.getByLabel("Amount for Bill SYN-1001");
  await expect(amount).toHaveValue("330.00");
  await amount.fill("100.00");
  await expect(page.getByText("Amount: $100.00 AUD")).toBeVisible();
  await page.getByLabel("Reference").fill("SYN-EFT-1");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page).toHaveURL(/\/payments\/supplier\/[0-9a-f-]{36}/);
  await expect(page.getByText("Payment recorded.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Payment to ${supplier}`,
  );

  await page.goto(billUrl);
  await expect(owed).toContainText("Paid$100.00 AUD");
  await expect(owed).toContainText("Still owing$230.00 AUD");
  await page.getByRole("link", { name: /^Paid / }).click();

  await page.getByRole("button", { name: "Void payment" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Void payment" }).click();
  await expect(dialog.getByText("Say why it's void")).toBeVisible();
  await dialog.getByLabel("Reason (required)").fill("Synthetic: entered twice");
  await dialog.getByRole("button", { name: "Void payment" }).click();
  await expect(page.getByText("Payment voided.")).toBeVisible();
  await expect(page.getByText("Void: Synthetic: entered twice")).toBeVisible();
  await page.goto(billUrl);
  await expect(owed).toContainText("Still owing$330.00 AUD");
});

test("owner records a customer receipt against an issued invoice", async ({
  page,
}, testInfo) => {
  await signIn(page, "owner");
  const gst = (await (await page.request.get("/api/company/gst")).json()) as {
    today: { registered: boolean };
  };
  const registered = gst.today.registered;
  const company = (await (await page.request.get("/api/company")).json()) as {
    legalName: string | null;
    abn: string | null;
  };
  if (registered && (!company.legalName || !company.abn))
    await write(
      page,
      "/api/company",
      {
        legalName: company.legalName ?? "Sample Contracting Pty Ltd",
        abn: company.abn ?? syntheticAbn("494949494"),
      },
      "PATCH",
    );
  const name = `Synthetic receipt customer ${randomUUID().slice(0, 8)}`;
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name,
  });
  const draft = await write<{ id: string }>(page, "/api/invoices", {
    customerId: customer.id,
    priceEntry: "exclusive",
    lines: [
      {
        description: "Synthetic site visit",
        quantity: "1",
        unitPriceCents: "50000",
        taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
      },
    ],
  });
  const issued = await write<{ reference: string; inclusiveCents: string }>(
    page,
    `/api/invoices/${draft.id}/issue`,
    {},
  );
  const total = registered ? "$550.00" : "$500.00";

  await page.goto("/payments?view=receipts");
  await expect(
    page.getByRole("heading", { name: "Customer receipts" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Record receipt" }).click();
  await page.getByLabel("Find customer", { exact: true }).fill(name);
  const select = page.getByLabel("Customer (required)", { exact: true });
  await expect(select.locator("option", { hasText: name })).toHaveCount(1);
  await select.selectOption({ label: name });
  const row = page.getByText(`Invoice ${issued.reference}`, { exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByText(`owing ${total} AUD`)).toBeVisible();
  await row.click();
  await expect(
    page.getByLabel(`Amount for Invoice ${issued.reference}`),
  ).toHaveValue(registered ? "550.00" : "500.00");
  await expect(page.getByText(`Amount: ${total} AUD`)).toBeVisible();
  await audit(page, testInfo, "receipt-form");
  await page.getByRole("button", { name: "Record receipt" }).click();
  await expect(page).toHaveURL(/\/payments\/receipts\/[0-9a-f-]{36}/);
  await expect(page.getByText("Receipt recorded.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Receipt from ${name}`,
  );
  await expect(page.getByText(`Invoice ${issued.reference}`)).toBeVisible();

  // Fully paid: nothing is left owing on that customer's invoices.
  await page.goto("/payments/receipts/new");
  await page.getByLabel("Find customer", { exact: true }).fill(name);
  await expect(select.locator("option", { hasText: name })).toHaveCount(1);
  await select.selectOption({ label: name });
  await expect(
    page.getByText("This customer has no invoices owing."),
  ).toBeVisible();
});

test("managers read payments; employees can't open them", async ({ page }) => {
  await signIn(page, "manager");
  await page.goto("/payments");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments");
  await expect(page.getByRole("link", { name: "Record bill" })).toHaveCount(0);
  expect((await page.goto("/payments/bills/new"))?.status()).toBe(404);
  expect((await page.goto("/payments/supplier/new"))?.status()).toBe(404);
  expect((await page.goto("/payments/receipts/new"))?.status()).toBe(404);
  await page.context().clearCookies();
  await signIn(page, "employee");
  expect((await page.goto("/payments"))?.status()).toBe(404);
  expect((await page.request.get("/api/bills")).status()).toBe(403);
});
