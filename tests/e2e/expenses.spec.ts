import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
test.setTimeout(120_000);
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
  expect(response.ok(), `${method} ${url}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
/** A job with the synthetic employee assigned to the whole job (as owner). */
async function fixture(page: Page) {
  const suffix = randomUUID().slice(0, 8);
  const accounts = requireAccounts();
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(accounts.emails.employee)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find(
    (member) => member.role === "employee",
  )!.userId;
  type Employee = { id: string; userId: string | null; isActive: boolean };
  const { employees } = (await (
    await page.request.get("/api/employees?status=all&pageSize=100")
  ).json()) as { employees: Employee[] };
  const employee =
    employees.find((row) => row.userId === userId) ??
    (await write<Employee>(page, "/api/employees", {
      name: "Synthetic Expense Employee",
      userId,
    }));
  if (!employee.isActive)
    await write(
      page,
      `/api/employees/${employee.id}`,
      { isActive: true },
      "PATCH",
    );
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic expense client ${suffix}`,
  });
  const job = await write<{ id: string; reference: string; title: string }>(
    page,
    "/api/jobs",
    { title: `Synthetic expense job ${suffix}`, customerId: customer.id },
  );
  await write(page, `/api/jobs/${job.id}/assignments`, {
    employeeId: employee.id,
  });
  return { job, suffix };
}
const breakdown = (page: Page) =>
  page.getByRole("region", { name: "GST breakdown", exact: true });
test("employee captures an expense with a live GST breakdown and edits it until decided", async ({
  page,
}) => {
  await signIn(page, "owner");
  const { job, suffix } = await fixture(page);
  await page.context().clearCookies();
  await signIn(page, "employee");
  await page.goto("/expenses");
  await expect(
    page.getByRole("heading", { name: "My expenses", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New expense", exact: true }).click();
  const form = page.locator("form").filter({ has: breakdown(page) });
  await expect(breakdown(page)).toContainText(
    "Enter an amount to see its GST.",
  );
  await form
    .getByLabel("Job *")
    .selectOption({ label: `${job.reference} · ${job.title}` });
  await form.getByLabel("What was bought *").fill(`Synthetic cable ${suffix}`);
  await form.getByLabel("Supplier").fill("Sample Electrical Supplies");
  await form.getByLabel("Amount incl GST *").fill("82.50");
  // Breakdown is live, from the same domain rule the server stores.
  await expect(breakdown(page)).toContainText("$75.00 AUD");
  await expect(breakdown(page)).toContainText("$7.50 AUD");
  await expect(breakdown(page)).toContainText("$82.50 AUD");
  await form.getByLabel("Ex GST", { exact: true }).check();
  await expect(breakdown(page)).toContainText("$8.25 AUD");
  await expect(breakdown(page)).toContainText("$90.75 AUD");
  await form.getByLabel("GST treatment *").selectOption("GST_FREE");
  await expect(breakdown(page)).toContainText("$0.00 AUD");
  await form.getByLabel("GST treatment *").selectOption("TAXABLE_10");
  await form.getByLabel("Incl GST (receipt total)").check();
  // A bad amount is a field error; entries are kept.
  await form.getByLabel("Amount incl GST *").fill("12.345");
  await form.getByRole("button", { name: "Submit expense" }).click();
  await expect(form.getByText(/at most two decimal places/)).toBeVisible();
  await expect(form.getByLabel("What was bought *")).toHaveValue(
    `Synthetic cable ${suffix}`,
  );
  await form.getByLabel("Amount incl GST *").fill("82.50");
  await form.getByRole("button", { name: "Submit expense" }).click();
  await expect(
    page.getByText("Expense submitted for approval.", { exact: true }),
  ).toBeVisible();
  const item = page.getByRole("listitem").filter({
    hasText: `Synthetic cable ${suffix}`,
  });
  await expect(item).toContainText("Awaiting approval");
  await expect(item).toContainText("$7.50 AUD");
  // Own list never carries the approval snapshot or cost split.
  const mine = (await (await page.request.get("/api/my/expenses")).json()) as {
    expenses: Record<string, unknown>[];
  };
  const row = mine.expenses.find(
    (expense) => expense.description === `Synthetic cable ${suffix}`,
  )!;
  expect(row).not.toHaveProperty("approval");
  expect(row).not.toHaveProperty("submittedBy");
  // Edit while awaiting approval.
  await item.getByRole("button", { name: "Edit expense" }).click();
  await item.getByLabel("Amount incl GST *").fill("110.00");
  await expect(
    item.getByRole("region", { name: "GST breakdown", exact: true }),
  ).toContainText("$10.00 AUD");
  await item.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Expense updated.", { exact: true }),
  ).toBeVisible();
  await expect(item).toContainText("$110.00 AUD");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Company-wide reads and the office detail stay closed to employees.
  expect([403, 404]).toContain(
    (await page.request.get("/api/expenses")).status(),
  );
  const response = await page.goto(`/expenses/${row.id as string}`);
  expect(response?.status()).toBe(404);
});

test("manager approves from the queue with a fixed snapshot, then reverses; accountant reads only", async ({
  page,
}) => {
  await signIn(page, "owner");
  const { job, suffix } = await fixture(page);
  await page.context().clearCookies();
  await signIn(page, "employee");
  const submitted = await write<{ id: string }>(page, "/api/expenses", {
    jobId: job.id,
    category: "materials",
    description: `Synthetic conduit ${suffix}`,
    purchasedOn: "2026-10-01",
    priceEntry: "inclusive",
    amountCents: "22000",
    taxCode: "TAXABLE_10",
    settlement: "paid_at_purchase",
    paymentMethod: "card",
  });
  await page.context().clearCookies();
  await signIn(page, "manager");
  await page.goto("/expenses");
  await expect(page.getByLabel("Show")).toHaveValue("submitted", {
    timeout: 30_000,
  });
  await page
    .getByRole("link", { name: `Synthetic conduit ${suffix}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `Synthetic conduit ${suffix}`,
      level: 1,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(breakdown(page)).toContainText("$200.00 AUD");
  await expect(breakdown(page)).toContainText("$20.00 AUD");
  // No receipt: verification can't be claimed.
  await expect(
    page.getByLabel("I checked the attached receipt or tax invoice"),
  ).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(
    page.getByText("Expense approved.", { exact: true }),
  ).toBeVisible();
  const snapshot = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Approval snapshot" }) });
  // Registered company, but no qualifying evidence: GST isn't claimable, so
  // it stays in job cost.
  await expect(snapshot).toContainText("Receipt not verified.");
  await expect(snapshot).toContainText("$220.00 AUD");
  await expect(
    page.getByRole("button", { name: "Record decision" }),
  ).toHaveCount(0);
  // Accountant sees it read-only.
  await page.context().clearCookies();
  await signIn(page, "accountant");
  await page.goto(`/expenses/${submitted.id}`);
  await expect(snapshot).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "Reverse expense" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New expense" })).toHaveCount(
    0,
  );
  // Manager reverses with a reason.
  await page.context().clearCookies();
  await signIn(page, "manager");
  await page.goto(`/expenses/${submitted.id}`);
  await expect(
    page.getByRole("button", { name: "Reverse expense" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reverse expense" }).click();
  await expect(page.getByText("Say why it's reversed").first()).toBeVisible();
  await page.getByLabel("Reason *").fill("Returned to supplier unused");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reverse expense" }).click();
  await expect(page.getByText(/Expense reversed/)).toBeVisible();
  await page.getByRole("link", { name: "Open the reversal" }).click();
  await expect(breakdown(page)).toContainText("−$220.00 AUD", {
    timeout: 30_000,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("expenses show empty, error and retry states, reflow at 390px and pass axe in both themes", async ({
  page,
}) => {
  await signIn(page, "manager");
  // Fail every list request until the error is shown (dev mode double-fetches).
  let failing = true;
  await page.route("**/api/expenses?*", async (route) => {
    if (failing) await route.fulfill({ status: 500, body: "{}" });
    else await route.continue();
  });
  await page.goto("/expenses");
  await expect(page.getByText(/Couldn't load this information/)).toBeVisible({
    timeout: 30_000,
  });
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/expenses? · Page 1/)).toBeVisible();
  await page.getByLabel("Show").selectOption("rejected");
  await expect(page.getByText(/expenses? · Page 1/)).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.getByLabel("Appearance").selectOption(scheme);
    await expect(page.locator("html")).toHaveClass(new RegExp(scheme));
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "New expense" }).click();
      await expect(breakdown(page)).toBeVisible({ timeout: 30_000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: `docs/testing/screenshots/expenses-${scheme}-${width}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  }
  // Subcontractors have no expenses module.
  await page.context().clearCookies();
  await signIn(page, "subcontractor");
  expect((await page.goto("/expenses"))?.status()).toBe(404);
});

test("real receipt upload attaches privately and the approver opens it via a short-lived link", async ({
  page,
}) => {
  // Integration gate: real private storage (CI MinIO); no route mocks.
  await signIn(page, "owner");
  const { job, suffix } = await fixture(page);
  await page.context().clearCookies();
  await signIn(page, "employee");
  await page.goto("/expenses");
  await page
    .getByRole("button", { name: "New expense", exact: true })
    .click({ timeout: 30_000 });
  const form = page.locator("form").filter({ has: breakdown(page) });
  await form
    .getByLabel("Job *")
    .selectOption({ label: `${job.reference} · ${job.title}` });
  await form
    .getByLabel("What was bought *")
    .fill(`Synthetic fittings ${suffix}`);
  await form.getByLabel("Amount incl GST *").fill("55.00");
  await form.getByLabel("Document type").selectOption("receipt");
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
  await form.getByLabel("Receipt photo or PDF").setInputFiles({
    name: "synthetic-receipt.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await form.getByRole("button", { name: "Submit expense" }).click();
  await expect(
    page.getByText("Expense submitted for approval.", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  const mine = (await (await page.request.get("/api/my/expenses")).json()) as {
    expenses: {
      id: string;
      description: string;
      receiptDocumentId: string | null;
    }[];
  };
  const row = mine.expenses.find(
    (expense) => expense.description === `Synthetic fittings ${suffix}`,
  )!;
  expect(row.receiptDocumentId).toBeTruthy();
  await page.context().clearCookies();
  await signIn(page, "manager");
  await page.goto(`/expenses/${row.id}`);
  await page
    .getByRole("button", { name: "Create receipt link" })
    .click({ timeout: 30_000 });
  const open = page.getByRole("link", { name: "Open receipt" });
  await expect(open).toBeVisible();
  const file = await page.request.get((await open.getAttribute("href"))!);
  expect(file.status()).toBe(200);
  expect(await file.body()).toEqual(pdf);
  await page
    .getByLabel("I checked the attached receipt or tax invoice")
    .check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(
    page.getByText("Receipt verified as qualifying evidence."),
  ).toBeVisible();
});
