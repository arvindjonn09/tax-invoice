import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
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

/**
 * The shared e2e company may or may not be registered for GST yet (the
 * settings spec registers it). Read the state; never change registration.
 */
async function setup(page: Page) {
  const gst = (await (await page.request.get("/api/company/gst")).json()) as {
    today: { registered: boolean };
  };
  const registered = gst.today.registered;
  const company = (await (await page.request.get("/api/company")).json()) as {
    legalName: string | null;
    abn: string | null;
  };
  // A registered company needs its legal identity on a tax invoice.
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
  const name = `Synthetic invoice customer ${randomUUID().slice(0, 8)}`;
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name,
  });
  return { registered, name, customerId: customer.id };
}

async function pickCustomer(page: Page, name: string) {
  await page.getByLabel("Find customer", { exact: true }).fill(name);
  const select = page.getByLabel("Customer (required)", { exact: true });
  await expect(select.locator("option", { hasText: name })).toHaveCount(1);
  await select.selectOption({ label: name });
}

test("owner drafts, issues and downloads the PDF of an invoice", async ({
  page,
}, testInfo) => {
  await signIn(page, "owner");
  const { registered, name } = await setup(page);
  const title = registered ? "Tax Invoice" : "Invoice";
  await page.goto("/invoices/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.getByText(/Total unavailable/)).toBeVisible();
  await pickCustomer(page, name);
  await page
    .getByLabel("Description (required)")
    .fill("Synthetic office fit-out");
  await page.getByLabel("Quantity (required)").fill("1");
  await page.getByLabel("Unit price (ex GST)").fill("2500.00");
  await expect(page.getByLabel("GST treatment (required)")).toHaveValue(
    registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
  );
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const total = registered ? "$2,750.00 AUD" : "$2,500.00 AUD";
  const totals = page.getByRole("region", { name: "Totals · AUD" });
  await expect(totals).toContainText(total);
  await expect(totals).toContainText(
    registered ? "$250.00 AUD" : "No GST charged",
  );

  // Unsaved edits mark totals stale and block issue until saved.
  await page
    .getByLabel("Description (required)")
    .fill("Synthetic office fit-out, stage 1");
  await expect(totals).toContainText("Unsaved changes");
  const review = page.getByRole("button", { name: "Review and issue" });
  await expect(review).toBeDisabled();
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await expect(review).toBeEnabled();

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
        path: testInfo.outputPath(`invoice-builder-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await review.click();
  const dialog = page.getByRole("dialog", {
    name: `Issue ${title.toLowerCase()}?`,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog).toContainText(total.replace(" AUD", ""));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog
    .getByRole("button", { name: `Issue ${title.toLowerCase()}` })
    .click();
  // Issue stores the PDF before responding (#48); the first render in a
  // cold CI server can take over 10s, plus the page navigation.
  await expect(page).toHaveURL(/issued=1/, { timeout: 30_000 });
  await expect(
    page.getByText(/issued\. It can no longer be edited\./),
  ).toBeVisible();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText(title);
  const reference = (await heading.textContent())!.replace(title, "").trim();
  expect(reference).toMatch(/\S+\d{4}$/);
  await expect(page.getByText(/Issued — read only/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);

  await page.getByRole("button", { name: "Get PDF" }).click();
  const download = page.getByRole("link", {
    name: `Download PDF (${reference})`,
  });
  await expect(download).toBeVisible();
  const file = await page.request.get((await download.getAttribute("href"))!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("application/pdf");
  expect((await file.body()).subarray(0, 5).toString()).toBe("%PDF-");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // The list shows it as issued.
  await page.goto("/invoices");
  await expect(
    page.getByRole("link", { name: `${title} ${reference}`, exact: true }),
  ).toBeVisible();
});

test("validation keeps the draft; credit notes and void follow the rules", async ({
  page,
}) => {
  await signIn(page, "owner");
  const { registered, name } = await setup(page);
  await page.goto("/invoices/new");
  await pickCustomer(page, name);
  await page.getByLabel("Description (required)").fill("Synthetic callout");
  await page.getByLabel("Unit price (ex GST)").fill("12.345");
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Fix 1 problem" }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Unit price (ex GST)"),
  ).toHaveAccessibleDescription(/at most two decimal places for line 1/);
  await expect(page.getByLabel("Description (required)")).toHaveValue(
    "Synthetic callout",
  );
  // A server-side rule failing comes back to the right field too.
  await page.getByLabel("Unit price (ex GST)").fill("80");
  await page.getByLabel("Quantity (required)").fill("0");
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(
    page.getByLabel("Quantity (required)"),
  ).toHaveAccessibleDescription(/more than 0/);
  await page.getByLabel("Quantity (required)").fill("2.5");
  await page.getByLabel("Unit (optional)").fill("h");
  await page.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByLabel("Description (required)").nth(1)).toBeFocused();
  await page.getByRole("button", { name: "Remove line 2" }).click();
  await page.getByRole("button", { name: "Undo remove" }).click();
  await expect(page.getByRole("group", { name: "Line 2" })).toBeVisible();
  await page.getByRole("button", { name: "Remove line 2" }).click();
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  // Switching entry mode keeps the amount: only its representation changes.
  await page.getByLabel("Incl GST", { exact: true }).check();
  await expect(page.getByLabel("Unit price (incl GST)")).toHaveValue(
    // Unregistered: no GST, so the price stands as typed.
    registered ? "88.00" : "80",
  );
  await page.getByLabel("Ex GST", { exact: true }).check();
  await expect(page.getByLabel("Unit price (ex GST)")).toHaveValue(
    registered ? "80.00" : "80",
  );
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review and issue" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Issue (tax )?invoice$/ })
    .click();
  await expect(page).toHaveURL(/issued=1/, { timeout: 30_000 });
  const invoiceUrl = page.url().replace(/\?.*$/, "");

  await page.getByRole("button", { name: "Create credit note" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    registered ? "Adjustment Note" : "Credit Note",
  );
  await expect(page.getByText(/Draft credit note for /)).toBeVisible();
  await page.getByRole("button", { name: "Review and issue" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Issue credit note" })
    .click();
  await expect(page).toHaveURL(/issued=1/, { timeout: 30_000 });
  await expect(page.getByText(/Credits invoice/)).toBeVisible();
  const creditUrl = page.url().replace(/\?.*$/, "");

  // An invoice with an issued credit note can't be voided: the server says why.
  await page.goto(invoiceUrl);
  await page.getByRole("button", { name: "Void invoice" }).click();
  const voiding = page.getByRole("dialog", { name: /^Void / });
  await expect(voiding.getByRole("button", { name: "Cancel" })).toBeFocused();
  await voiding.getByLabel("Reason (required)").fill("Entered twice");
  await voiding.getByRole("button", { name: "Void invoice" }).click();
  await expect(
    page.getByText(/credit notes; credit the rest instead of voiding/),
  ).toBeVisible();

  // A successful void updates the page at once: status, reason, no actions.
  await page.goto(creditUrl);
  await page.getByRole("button", { name: /^Void / }).click();
  const voidCredit = page.getByRole("dialog", { name: /^Void / });
  await voidCredit.getByLabel("Reason (required)").fill("Issued in error");
  await voidCredit.getByRole("button", { name: /^Void / }).click();
  await expect(page.getByText(/ is void\.$/)).toBeVisible();
  await expect(page.getByText("Void — Issued in error")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Void / })).toHaveCount(0);
});

test("roles: manager reads invoices only; workers can't open them", async ({
  page,
}) => {
  await signIn(page, "manager");
  await page.goto("/invoices");
  await expect(
    page.getByRole("heading", { name: "Invoices", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Status").selectOption("void");
  // The void flow above voids a credit note; no spec voids an invoice.
  await page.getByLabel("Type").selectOption("invoice");
  await expect(
    page.getByRole("heading", { name: "No matching invoices" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "New invoice" })).toHaveCount(0);
  expect((await page.goto("/invoices/new"))?.status()).toBe(404);

  // An existing draft opens read only: no editor a manager can't save.
  await page.context().clearCookies();
  await signIn(page, "owner");
  const { registered, name, customerId } = await setup(page);
  const draft = await write<{ id: string }>(page, "/api/invoices", {
    customerId,
    priceEntry: "exclusive",
    lines: [
      {
        description: "Synthetic manager-visible line",
        quantity: "2",
        unit: "hr",
        unitPriceCents: "5000",
        taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
      },
    ],
  });
  await page.context().clearCookies();
  await signIn(page, "manager");
  await page.goto(`/invoices/${draft.id}`);
  await expect(
    page.getByRole("heading", { name: "Draft invoice", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  const lines = page.getByRole("region", { name: "Lines" });
  await expect(lines).toContainText("1. Synthetic manager-visible line");
  await expect(lines).toContainText("$100.00 ex GST");
  for (const button of ["Save draft", "Review and issue", "Discard draft"])
    await expect(page.getByRole("button", { name: button })).toHaveCount(0);
  const main = page.getByRole("main");
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(main.getByRole("combobox")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const edit = await page.request.fetch(`/api/invoices/${draft.id}`, {
    method: "PATCH",
    headers: { origin: new URL(page.url()).origin },
    data: { notes: "Synthetic manager edit" },
  });
  expect(edit.status()).toBe(403);

  for (const role of ["employee", "subcontractor"] as const) {
    await page.context().clearCookies();
    await signIn(page, role);
    expect((await page.goto("/invoices"))?.status()).toBe(404);
    expect((await page.goto("/invoices/new"))?.status()).toBe(404);
    expect((await page.request.get("/api/invoices")).status()).toBe(403);
  }
});
