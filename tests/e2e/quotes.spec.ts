import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
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

/** Registration is read, never changed: the settings spec owns it. */
async function registered(page: Page) {
  const gst = (await (await page.request.get("/api/company/gst")).json()) as {
    today: { registered: boolean };
  };
  return gst.today.registered;
}

async function customer(page: Page) {
  const name = `Synthetic quote customer ${randomUUID().slice(0, 8)}`;
  const { id } = await write<{ id: string }>(page, "/api/customers", { name });
  return { name, id };
}

test("manager drafts, sends and accepts a quote into a job", async ({
  page,
}, testInfo) => {
  // Registration is owner/accountant data; read it as the owner first.
  await signIn(page, "owner");
  const gst = await registered(page);
  await page.context().clearCookies();
  await signIn(page, "manager");
  const { name } = await customer(page);
  await page.goto("/quotes/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New quote");
  await expect(page.getByText(/Total unavailable/)).toBeVisible();
  await page.getByLabel("Find customer", { exact: true }).fill(name);
  const select = page.getByLabel("Customer (required)", { exact: true });
  await expect(select.locator("option", { hasText: name })).toHaveCount(1);
  await select.selectOption({ label: name });
  await page.getByLabel("Title (required)").fill("Synthetic deck rebuild");
  await page
    .getByLabel("Description (required)")
    .fill("Synthetic decking labour");
  await page.getByLabel("Quantity (required)").fill("2");
  await page.getByLabel("Unit price (ex GST)").fill("1000.00");
  await page.getByLabel("Estimated cost, ex GST (internal)").fill("1200.00");
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/);
  const totals = page.getByRole("region", { name: "Totals · AUD" });
  // New lines default to Taxable only while registered today.
  const total = gst ? "$2,200.00 AUD" : "$2,000.00 AUD";
  await expect(totals).toContainText(total);
  const estimate = page.getByRole("region", { name: "Internal estimate" });
  await expect(estimate).toContainText("$2,000.00");
  await expect(estimate).toContainText("$800.00");
  await expect(estimate).toContainText("40.0% margin");

  // Unsaved edits mark totals stale and block sending.
  await page
    .getByLabel("Title (required)")
    .fill("Synthetic deck rebuild, stage 1");
  await expect(totals).toContainText("Unsaved changes");
  const review = page.getByRole("button", { name: "Review and send" });
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
        path: testInfo.outputPath(`quote-builder-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("Appearance").selectOption("light");

  await review.click();
  const send = page.getByRole("dialog");
  await expect(send.getByRole("button", { name: "Cancel" })).toBeFocused();
  await send.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /^Quote Q-\d{4}$/,
  );
  await expect(page.getByText("Sent · awaiting decision")).toBeVisible();
  await expect(totals).toContainText(total);
  if (!gst) await expect(totals).toContainText("No GST charged");
  await expect(page.getByLabel("Title (required)")).toHaveCount(0);

  await page.getByRole("button", { name: "Record acceptance" }).click();
  const accept = page.getByRole("dialog");
  await expect(accept).toContainText("$2,000.00 ex GST");
  await accept.getByLabel("Note (optional)").fill("Synthetic verbal approval");
  await accept.getByRole("button", { name: "Record acceptance" }).click();
  await expect(page.getByText(/Quote accepted/)).toBeVisible();
  await expect(page.getByText("Synthetic verbal approval")).toBeVisible();
  await page.getByRole("link", { name: "Open the job" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Synthetic deck rebuild, stage 1",
  );
});

test("a declined quote is revised into a new draft", async ({ page }) => {
  await signIn(page, "owner");
  const { id: customerId } = await customer(page);
  const quote = await write<{ id: string; reference: string }>(
    page,
    "/api/quotes",
    {
      customerId,
      kind: "quote",
      title: "Synthetic fence repair",
      priceEntry: "exclusive",
      lines: [
        {
          description: "Synthetic fence panel",
          quantity: "3",
          unitPriceCents: "15000",
          taxCode: "GST_FREE",
        },
      ],
    },
  );
  await write(page, `/api/quotes/${quote.id}/send`, {});
  await page.goto(`/quotes/${quote.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Quote ${quote.reference}`,
  );
  await page.getByRole("button", { name: "Record decline" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByLabel("Note (optional)").fill("Synthetic: price too high");
  await dialog.getByRole("button", { name: "Record decline" }).click();
  await expect(page.getByText("Quote declined.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record acceptance" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Revise" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Quote ${quote.reference} rev 2`,
  );
  await expect(page.getByLabel("Title (required)")).toHaveValue(
    "Synthetic fence repair",
  );
  await expect(page.getByLabel("Description (required)")).toHaveValue(
    "Synthetic fence panel",
  );
});

test("accountants read quotes; employees can't open them", async ({ page }) => {
  await signIn(page, "accountant");
  await page.goto("/quotes");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quotes");
  await expect(page.getByRole("link", { name: "New quote" })).toHaveCount(0);
  expect((await page.goto("/quotes/new"))?.status()).toBe(404);
  await page.context().clearCookies();
  await signIn(page, "employee");
  expect((await page.goto("/quotes"))?.status()).toBe(404);
  const api = await page.request.get("/api/quotes");
  expect(api.status()).toBe(403);
});
