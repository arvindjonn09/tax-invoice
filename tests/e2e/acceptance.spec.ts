import { randomBytes, randomUUID } from "node:crypto";
import {
  test,
  expect,
  type Browser,
  type Page,
  type APIResponse,
} from "@playwright/test";
import { createDatabaseClient } from "../../packages/database/src/index";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { isolatedTestConnection } from "../helpers/test-environment";
import { syntheticAbn } from "../helpers/abn";
import { requireAccounts } from "./accounts";

// The critical acceptance test (#59; README "CRITICAL ACCEPTANCE TEST" and
// docs/GST.md "Combined GST and profit acceptance fixture"). Each variant
// runs the whole workflow through the real app, as the roles that do it,
// in its own synthetic company so every figure is exact:
//   customer → job $2,500 → subcontractor $900 → labour $300 →
//   materials $150 → travel $100 → invoice → receipt $1,000 →
//   subcontractor payment $400
// then reconciles dashboard = reports = database sums.
test.setTimeout(240_000);
test.describe.configure({ mode: "serial" });

type Variant = {
  name: string;
  registered: boolean;
  basis: "non_cash" | "cash";
  /** Expected, in cents, from README and docs/GST.md. */
  invoiceInclusive: bigint;
  billInclusive: bigint;
  customerOutstanding: bigint;
  supplierOutstanding: bigint;
  gst: { g1: bigint; oneA: bigint; oneB: bigint; netGst: bigint };
  /** Whether the materials' tax invoice is attached and verified. */
  materialsEvidence: boolean;
  profit: { cost: string; profit: string; marginBasisPoints: string };
};
const FIXTURE_PROFIT = {
  cost: "145000",
  profit: "105000",
  marginBasisPoints: "4200",
};
const VARIANTS: Variant[] = [
  {
    name: "not registered for GST",
    registered: false,
    basis: "non_cash",
    invoiceInclusive: 250000n,
    billInclusive: 90000n,
    customerOutstanding: 150000n,
    supplierOutstanding: 50000n,
    gst: { g1: 0n, oneA: 0n, oneB: 0n, netGst: 0n },
    materialsEvidence: true,
    profit: FIXTURE_PROFIT,
  },
  {
    name: "GST-registered, non-cash basis",
    registered: true,
    basis: "non_cash",
    invoiceInclusive: 275000n,
    billInclusive: 99000n,
    customerOutstanding: 175000n,
    supplierOutstanding: 59000n,
    // 1A $250; 1B $90 + $15; net $145.
    gst: { g1: 275000n, oneA: 25000n, oneB: 10500n, netGst: 14500n },
    materialsEvidence: true,
    profit: FIXTURE_PROFIT,
  },
  {
    // docs/GST.md non-creditable variant: no tax invoice for the materials,
    // so their $15 GST is job cost and isn't claimed.
    name: "GST-registered, materials without a tax invoice",
    registered: true,
    basis: "non_cash",
    invoiceInclusive: 275000n,
    billInclusive: 99000n,
    customerOutstanding: 175000n,
    supplierOutstanding: 59000n,
    gst: { g1: 275000n, oneA: 25000n, oneB: 9000n, netGst: 16000n },
    materialsEvidence: false,
    profit: { cost: "146500", profit: "103500", marginBasisPoints: "4140" },
  },
  {
    name: "GST-registered, cash basis",
    registered: true,
    basis: "cash",
    invoiceInclusive: 275000n,
    billInclusive: 99000n,
    customerOutstanding: 175000n,
    supplierOutstanding: 59000n,
    // 1A: 1/11 of the $1,000 receipt = 9091 (R7). 1B: the materials paid
    // at purchase (1500) + round(40000 × 9000 / 99000) = 3636 of the bill.
    gst: { g1: 100000n, oneA: 9091n, oneB: 5136n, netGst: 3955n },
    materialsEvidence: true,
    profit: FIXTURE_PROFIT,
  },
];

const ROLES = ["owner", "employee", "subcontractor"] as const;
type Role = (typeof ROLES)[number];
type Company = {
  id: string;
  password: string;
  emails: Record<Role, string>;
  userIds: Record<Role, string>;
};

/** A synthetic company of its own, so nothing else changes its figures. */
async function createCompany(variant: Variant): Promise<Company> {
  const db = createDatabaseClient(isolatedTestConnection());
  try {
    const run = randomUUID().slice(0, 8);
    const password = randomBytes(18).toString("base64url");
    const emails = {} as Record<Role, string>;
    const userIds = {} as Record<Role, string>;
    for (const role of ROLES) {
      emails[role] = `acceptance-${run}-${role}@jobflow.invalid`;
      userIds[role] = (
        await createCredentialUser(db, {
          email: emails[role],
          name: `Acceptance ${role}`,
          password,
        })
      ).id;
    }
    const id = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.company.create({
        data: {
          id,
          name: `Acceptance ${variant.name} ${run}`,
          accessMode: "unrestricted",
          legalName: "Synthetic Acceptance Pty Ltd",
          abn: syntheticAbn("515151515"),
          addressLine1: "1 Synthetic Street",
          suburb: "Testville",
          state: "NSW",
          postcode: "2000",
          createdBy: userIds.owner,
          isDemo: true,
        },
      });
      for (const role of ROLES)
        await tx.membership.create({
          data: {
            companyId: id,
            userId: userIds[role],
            role,
            createdBy: userIds.owner,
          },
        });
      if (variant.registered)
        await tx.companyGstRegistration.create({
          data: {
            companyId: id,
            startsOn: new Date("2026-01-01T00:00:00Z"),
            basis: variant.basis,
            createdBy: userIds.owner,
          },
        });
    });
    return { id, password, emails, userIds };
  } finally {
    await db.$disconnect();
  }
}

async function signInAs(page: Page, company: Company, role: Role) {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(company.emails[role]);
  await page.getByLabel("Password").fill(company.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}
async function asRole(browser: Browser, company: Company, role: Role) {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, company, role);
  return page;
}

const send = (
  page: Page,
  url: string,
  data: unknown,
  { method = "POST", key }: { method?: string; key?: string } = {},
): Promise<APIResponse> =>
  page.request.fetch(url, {
    method,
    headers: {
      origin: new URL(page.url()).origin,
      ...(key ? { "idempotency-key": key } : {}),
    },
    data,
  });
async function write<T>(
  page: Page,
  url: string,
  data: unknown,
  options: { method?: string; key?: string } = {},
): Promise<T> {
  const response = await send(page, url, data, options);
  expect(
    response.ok(),
    `${options.method ?? "POST"} ${url}: ${response.status()} ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as T;
}
async function read<T>(page: Page, url: string): Promise<T> {
  const response = await page.request.get(url);
  expect(response.ok(), `GET ${url}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}
async function upload(page: Page, kind: "receipt" | "tax_invoice") {
  const response = await page.request.post("/api/documents", {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      kind,
      file: {
        name: `synthetic-${kind}.pdf`,
        mimeType: "application/pdf",
        buffer: Buffer.from(
          "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
        ),
      },
    },
  });
  expect(response.ok(), `upload: ${response.status()}`).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

const sydneyToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    new Date(),
  );
/** The dashboard's default range: the current quarter up to today. */
const quarter = (today: string) => {
  const month = Number(today.slice(5, 7));
  return {
    from: `${today.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`,
    to: today,
  };
};
const aud = (cents: bigint) => {
  const whole = new Intl.NumberFormat("en-AU").format(cents / 100n);
  return `$${whole}.${(cents % 100n).toString().padStart(2, "0")} AUD`;
};

test.beforeEach(() => {
  requireAccounts();
});

for (const variant of VARIANTS)
  test(`critical acceptance: ${variant.name}`, async ({ page, browser }) => {
    const company = await createCompany(variant);
    const today = sydneyToday();
    const range = quarter(today);
    const taxCode = variant.registered ? "TAXABLE_10" : "OUT_OF_SCOPE";
    const suffix = randomUUID().slice(0, 8);
    await signInAs(page, company, "owner");

    // Customer and job priced at $2,500.
    const customer = await write<{ id: string }>(page, "/api/customers", {
      name: `Acceptance customer ${suffix}`,
    });
    const job = await write<{ id: string; reference: string }>(
      page,
      "/api/jobs",
      {
        title: `Acceptance job ${suffix}`,
        customerId: customer.id,
        agreedPriceExclusiveCents: "250000",
      },
    );

    // Subcontractor $900: offered by the office, accepted in the portal.
    const contractor = await write<{ id: string }>(page, "/api/contractors", {
      name: `Acceptance contractor ${suffix}`,
      userId: company.userIds.subcontractor,
      gstRegistered: variant.registered,
      ...(variant.registered ? { abn: syntheticAbn("525252525") } : {}),
    });
    const offer = await write<{ id: string }>(
      page,
      `/api/jobs/${job.id}/offers`,
      {
        contractorId: contractor.id,
        scope: "Synthetic subcontract work",
        rateType: "fixed",
        rateExclusiveCents: "90000",
        taxCode,
      },
    );
    const sub = await asRole(browser, company, "subcontractor");
    await write(sub, `/api/my/offers/${offer.id}`, {
      decision: "accept",
      note: "Synthetic acceptance",
    });
    await sub.context().close();

    // Employee labour $300: 5 hours at $60, logged by the employee and
    // approved by the office.
    const employee = await write<{ id: string }>(page, "/api/employees", {
      name: `Acceptance employee ${suffix}`,
      userId: company.userIds.employee,
    });
    await write(page, `/api/employees/${employee.id}/rates`, {
      effectiveFrom: "2026-01-01",
      hourlyCostCents: "6000",
    });
    await write(page, `/api/jobs/${job.id}/assignments`, {
      employeeId: employee.id,
    });
    const worker = await asRole(browser, company, "employee");
    const timesheet = await write<{ id: string }>(worker, "/api/timesheets", {
      jobId: job.id,
      workDate: today,
      minutes: 300,
    });
    await worker.context().close();
    expect(
      (
        await write<{ costCents: string }>(
          page,
          `/api/timesheets/${timesheet.id}/decision`,
          { decision: "approve" },
        )
      ).costCents,
    ).toBe("30000");

    // Materials $150 (with a verified tax invoice) and travel $100 (no
    // GST), both paid at purchase and approved.
    for (const [category, amount, code, receipt] of [
      ["materials", "15000", taxCode, variant.materialsEvidence],
      [
        "travel",
        "10000",
        variant.registered ? "GST_FREE" : "OUT_OF_SCOPE",
        false,
      ],
    ] as const) {
      const expense = await write<{ id: string }>(page, "/api/expenses", {
        jobId: job.id,
        category,
        description: `Synthetic ${category}`,
        purchasedOn: today,
        priceEntry: "exclusive",
        amountCents: amount,
        taxCode: code,
        // Over $82.50 incl GST, a credit needs a tax invoice (R5).
        receiptDocumentId: receipt ? await upload(page, "tax_invoice") : null,
        settlement: "paid_at_purchase",
        paymentMethod: "card",
      });
      await write(page, `/api/expenses/${expense.id}/decision`, {
        decision: "approve",
        evidenceVerified: receipt,
      });
    }

    // The subcontractor's bill for the accepted offer.
    const bill = await write<{ id: string; inclusiveCents: string }>(
      page,
      "/api/bills",
      {
        contractorId: contractor.id,
        offerId: offer.id,
        jobId: job.id,
        supplierReference: `SUB-${suffix}`,
        issuedOn: today,
        lines: [
          {
            description: "Synthetic subcontract work",
            taxCode,
            exclusiveCents: "90000",
            gstCents: variant.registered ? "9000" : "0",
          },
        ],
        documentId: await upload(page, "tax_invoice"),
        evidenceVerified: true,
      },
    );
    expect(BigInt(bill.inclusiveCents)).toBe(variant.billInclusive);

    // Customer invoice for $2,500 ex GST.
    const draft = await write<{ id: string }>(page, "/api/invoices", {
      customerId: customer.id,
      jobId: job.id,
      lines: [
        {
          description: "Synthetic job as agreed",
          quantity: "1",
          unitPriceCents: "250000",
          taxCode,
        },
      ],
    });
    const invoice = await write<{
      reference: string;
      title: string;
      inclusiveCents: string;
    }>(page, `/api/invoices/${draft.id}/issue`, { issueDate: today });
    expect(invoice.title).toBe(variant.registered ? "Tax Invoice" : "Invoice");
    expect(BigInt(invoice.inclusiveCents)).toBe(variant.invoiceInclusive);

    const profit = async () =>
      (
        await read<{
          totals: {
            revenue: string;
            cost: string;
            profit: string;
            marginBasisPoints: string;
          };
        }>(
          page,
          `/api/reports/profitability?${new URLSearchParams({ ...range, jobId: job.id })}`,
        )
      ).totals;
    const expectedProfit = { revenue: "250000", ...variant.profit };
    expect(await profit()).toMatchObject(expectedProfit);

    // The README's negative cases, before the real settlements.
    const receiptBody = (amount: string) => ({
      customerId: customer.id,
      receivedOn: today,
      amountCents: amount,
      method: "bank_transfer",
      allocations: [{ invoiceId: draft.id, amountCents: amount }],
    });
    expect(
      (
        await send(page, "/api/receipts", receiptBody("-100000"), {
          key: randomUUID(),
        })
      ).status(),
    ).toBe(400);
    const over = (variant.invoiceInclusive + 1n).toString();
    expect(
      (
        await send(page, "/api/receipts", receiptBody(over), {
          key: randomUUID(),
        })
      ).status(),
    ).toBe(400);
    const worker2 = await asRole(browser, company, "employee");
    for (const url of [
      "/api/reports/profitability?from=2026-01-01&to=2026-12-31",
      "/api/dashboard?from=2026-01-01&to=2026-12-31",
      `/api/invoices/${draft.id}`,
      "/api/receipts",
    ])
      expect((await worker2.request.get(url)).status(), url).toBe(403);
    expect(
      (
        await send(worker2, "/api/receipts", receiptBody("100000"), {
          key: randomUUID(),
        })
      ).status(),
    ).toBe(403);
    await worker2.context().close();

    // A partial receipt of $1,000, submitted twice with one key: recorded once.
    const key = randomUUID();
    const first = await write<{ id: string }>(
      page,
      "/api/receipts",
      receiptBody("100000"),
      { key },
    );
    const again = await send(page, "/api/receipts", receiptBody("100000"), {
      key,
    });
    expect(again.status()).toBeLessThan(300);
    expect(((await again.json()) as { id: string }).id).toBe(first.id);

    // Pay $400 against the subcontractor bill, also twice with one key.
    const paymentKey = randomUUID();
    const paymentBody = {
      paidOn: today,
      amountCents: "40000",
      method: "bank_transfer",
      allocations: [{ billId: bill.id, amountCents: "40000" }],
    };
    const paid = await write<{ id: string }>(
      page,
      "/api/supplier-payments",
      paymentBody,
      { key: paymentKey },
    );
    const paidAgain = await send(page, "/api/supplier-payments", paymentBody, {
      key: paymentKey,
    });
    expect(((await paidAgain.json()) as { id: string }).id).toBe(paid.id);
    // An overpayment of the bill is refused.
    expect(
      (
        await send(
          page,
          "/api/supplier-payments",
          {
            ...paymentBody,
            amountCents: variant.billInclusive.toString(),
            allocations: [
              {
                billId: bill.id,
                amountCents: variant.billInclusive.toString(),
              },
            ],
          },
          { key: randomUUID() },
        )
      ).status(),
    ).toBe(400);

    // Voiding is a correction, never an edit: a second, mistaken invoice
    // issued and voided leaves the job's figures as they were.
    const mistake = await write<{ id: string }>(page, "/api/invoices", {
      customerId: customer.id,
      jobId: job.id,
      lines: [
        {
          description: "Synthetic duplicate invoice",
          quantity: "1",
          unitPriceCents: "250000",
          taxCode,
        },
      ],
    });
    await write(page, `/api/invoices/${mistake.id}/issue`, {
      issueDate: today,
    });
    await write(page, `/api/invoices/${mistake.id}/void`, {
      reason: "Synthetic duplicate",
    });

    // Payments never change profit.
    expect(await profit()).toMatchObject(expectedProfit);

    // Reports: GST, outstanding balances.
    const gst = await read<{
      g1: string;
      oneA: string;
      oneB: string;
      netGst: string;
    }>(page, `/api/reports/gst?${new URLSearchParams(range)}`);
    expect({
      g1: BigInt(gst.g1),
      oneA: BigInt(gst.oneA),
      oneB: BigInt(gst.oneB),
      netGst: BigInt(gst.netGst),
    }).toEqual(variant.gst);
    const owed = async (side: string) =>
      BigInt(
        (
          await read<{ totals: { total: string } }>(
            page,
            `/api/reports/ageing?side=${side}&asAt=${today}`,
          )
        ).totals.total,
      );
    expect(await owed("receivables")).toBe(variant.customerOutstanding);
    expect(await owed("payables")).toBe(variant.supplierOutstanding);

    // Dashboard = reports.
    const dashboard = await read<{
      totals: Record<string, string>;
      gst: { g1: string; oneA: string; oneB: string; netGst: string } | null;
      ledger: {
        receivables: { total: string };
        payables: { total: string };
      } | null;
    }>(page, `/api/dashboard?${new URLSearchParams(range)}`);
    expect(dashboard.totals).toMatchObject(expectedProfit);
    expect(dashboard.gst).toMatchObject({
      g1: gst.g1,
      oneA: gst.oneA,
      oneB: gst.oneB,
      netGst: gst.netGst,
    });
    expect(BigInt(dashboard.ledger!.receivables.total)).toBe(
      variant.customerOutstanding,
    );
    expect(BigInt(dashboard.ledger!.payables.total)).toBe(
      variant.supplierOutstanding,
    );

    // = database sums, read straight from the records.
    const db = createDatabaseClient(isolatedTestConnection());
    try {
      const [sums] = await db.$queryRaw<
        {
          revenue: bigint;
          cost: bigint;
          receivable: bigint;
          payable: bigint;
        }[]
      >`
        SELECT
          (SELECT COALESCE(SUM(exclusive_cents),0) FROM invoices
            WHERE company_id=${company.id}::uuid AND job_id=${job.id}::uuid
              AND kind='invoice' AND status='issued')::bigint AS revenue,
          ((SELECT COALESCE(SUM(job_cost_cents),0) FROM supplier_bills
             WHERE company_id=${company.id}::uuid AND job_id=${job.id}::uuid AND voided_at IS NULL)
           + (SELECT COALESCE(SUM(job_cost_cents),0) FROM expenses
             WHERE company_id=${company.id}::uuid AND job_id=${job.id}::uuid AND status='approved')
           + (SELECT COALESCE(SUM(cost_cents),0) FROM timesheets
             WHERE company_id=${company.id}::uuid AND job_id=${job.id}::uuid AND status='approved'))::bigint AS cost,
          ((SELECT COALESCE(SUM(inclusive_cents),0) FROM invoices
             WHERE company_id=${company.id}::uuid AND kind='invoice' AND status='issued')
           - (SELECT COALESCE(SUM(a.amount_cents),0) FROM receipt_allocations a
             JOIN customer_receipts r ON r.id=a.receipt_id
             WHERE a.company_id=${company.id}::uuid AND r.voided_at IS NULL))::bigint AS receivable,
          ((SELECT COALESCE(SUM(inclusive_cents),0) FROM supplier_bills
             WHERE company_id=${company.id}::uuid AND voided_at IS NULL)
           - (SELECT COALESCE(SUM(a.amount_cents),0) FROM supplier_payment_allocations a
             JOIN supplier_payments p ON p.id=a.payment_id
             WHERE a.company_id=${company.id}::uuid AND p.voided_at IS NULL))::bigint AS payable`;
      expect(sums).toEqual({
        revenue: 250000n,
        cost: BigInt(variant.profit.cost),
        receivable: variant.customerOutstanding,
        payable: variant.supplierOutstanding,
      });
      // One receipt and one payment despite the repeated submissions.
      expect(
        await db.customerReceipt.count({ where: { companyId: company.id } }),
      ).toBe(1);
      expect(
        await db.supplierPayment.count({ where: { companyId: company.id } }),
      ).toBe(1);
    } finally {
      await db.$disconnect();
    }

    // What the owner sees on screen matches.
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Dashboard", level: 1 }),
    ).toBeVisible();
    const profitTiles = page.getByLabel("Profit in this range");
    await expect(profitTiles).toContainText(`${aud(250000n)} ex GST`);
    const cost = BigInt(variant.profit.cost),
      gross = BigInt(variant.profit.profit),
      bp = BigInt(variant.profit.marginBasisPoints);
    await expect(profitTiles).toContainText(`${aud(cost)} ex GST`);
    await expect(profitTiles).toContainText(`${aud(gross)} ex GST`);
    await expect(profitTiles).toContainText(
      `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}% margin`,
    );
    // #305: a company that has never been registered charged no GST, so
    // its balances don't say "incl GST".
    await expect(
      page
        .getByText(
          `${aud(variant.customerOutstanding)} ${variant.registered ? "incl GST" : "no GST"}`,
        )
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByText(
          `${aud(variant.supplierOutstanding)} ${variant.registered ? "incl GST" : "total"}`,
        )
        .first(),
    ).toBeVisible();
    await page.goto(`/reports?view=profitability`);
    await expect(
      page.getByRole("heading", { name: "What makes up these figures" }),
    ).toBeVisible();
    await expect(page.getByText(`${aud(gross)} ex GST`).first()).toBeVisible();
  });
