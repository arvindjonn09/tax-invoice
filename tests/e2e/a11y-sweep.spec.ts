import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { requireAccounts, signIn, type E2eRole } from "./accounts";

// #60 accessibility and responsive audit: every screen each role can open,
// at phone and desktop widths, in light and dark. Each must load with one
// h1, a skip link to main content, no horizontal scrolling and no axe
// violations (WCAG 2.2 AA rules). Screen-specific interaction checks live in
// each feature's own spec; this sweep makes sure no screen is missed.
test.setTimeout(900_000);
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
    "/quotes/new",
    "/invoices",
    "/invoices/new",
    "/payments",
    "/payments?view=payments",
    "/payments?view=receipts",
    "/payments/bills/new",
    "/payments/receipts/new",
    "/payments/supplier/new",
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

async function settled(page: Page, path: string) {
  // Client screens fetch after hydration. A screen still loading after 30 s
  // fails the audit: only loaded content counts as checked.
  await expect(page.getByRole("heading", { level: 1 }), path).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(
    page.locator('[role="status"]', { hasText: /Loading/ }),
    `${path} never finished loading`,
  ).toHaveCount(0, { timeout: 30_000 });
}

async function write<T>(page: Page, url: string, data: unknown): Promise<T> {
  const response = await page.request.post(url, {
    headers: {
      origin: new URL(page.url()).origin,
      "idempotency-key": randomUUID(),
    },
    data,
  });
  expect(response.ok(), `${url}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

/**
 * One synthetic record of each kind, so every detail screen is audited
 * with real content: customer, job, quote, issued invoice, bill, receipt,
 * supplier payment, expense, employee and contractor (with an offer to the
 * shared subcontractor login).
 */
async function seedDetails(page: Page) {
  const suffix = randomUUID().slice(0, 8);
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name: `Synthetic a11y customer ${suffix}`,
  });
  const job = await write<{ id: string }>(page, "/api/jobs", {
    title: `Synthetic a11y job ${suffix}`,
    customerId: customer.id,
    agreedPriceExclusiveCents: "120000",
  });
  const line = {
    description: "Synthetic a11y work",
    quantity: "1",
    unitPriceCents: "120000",
    taxCode: "OUT_OF_SCOPE",
  };
  const quote = await write<{ id: string }>(page, "/api/quotes", {
    customerId: customer.id,
    kind: "quote",
    title: "Synthetic a11y quote",
    priceEntry: "exclusive",
    lines: [line],
  });
  const draft = await write<{ id: string }>(page, "/api/invoices", {
    customerId: customer.id,
    jobId: job.id,
    lines: [line],
  });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
  }).format(new Date());
  await write(page, `/api/invoices/${draft.id}/issue`, { issueDate: today });
  const receipt = await write<{ id: string }>(page, "/api/receipts", {
    customerId: customer.id,
    receivedOn: today,
    amountCents: "20000",
    method: "bank_transfer",
    allocations: [{ invoiceId: draft.id, amountCents: "20000" }],
  });
  const bill = await write<{ id: string }>(page, "/api/bills", {
    jobId: job.id,
    supplierName: `Synthetic a11y supplier ${suffix}`,
    supplierGstRegistered: false,
    issuedOn: today,
    lines: [
      {
        description: "Synthetic a11y materials",
        taxCode: "OUT_OF_SCOPE",
        exclusiveCents: "30000",
        gstCents: "0",
      },
    ],
  });
  const payment = await write<{ id: string }>(page, "/api/supplier-payments", {
    paidOn: today,
    amountCents: "10000",
    method: "bank_transfer",
    allocations: [{ billId: bill.id, amountCents: "10000" }],
  });
  const expense = await write<{ id: string }>(page, "/api/expenses", {
    jobId: job.id,
    category: "materials",
    description: "Synthetic a11y purchase",
    purchasedOn: today,
    priceEntry: "exclusive",
    amountCents: "5000",
    taxCode: "OUT_OF_SCOPE",
    settlement: "paid_at_purchase",
    paymentMethod: "card",
  });
  const employee = await write<{ id: string }>(page, "/api/employees", {
    name: `Synthetic a11y employee ${suffix}`,
  });
  // The shared subcontractor login's contractor record, created once.
  const users = (await (
    await page.request.get(
      `/api/users?q=${encodeURIComponent(requireAccounts().emails.subcontractor)}`,
    )
  ).json()) as { members: { userId: string; role: string }[] };
  const userId = users.members.find((m) => m.role === "subcontractor")!.userId;
  // Other specs create it in parallel; a lost race re-reads it.
  let contractor: { id: string } | undefined;
  for (let attempt = 0; attempt < 3 && !contractor; attempt++) {
    const directory = (await (
      await page.request.get(
        "/api/contractors?status=all&q=Synthetic%20portal&pageSize=100",
      )
    ).json()) as { contractors: { id: string; userId: string | null }[] };
    contractor = directory.contractors.find((c) => c.userId === userId);
    if (contractor) break;
    const created = await page.request.post("/api/contractors", {
      headers: { origin: new URL(page.url()).origin },
      // Named as portal.spec.ts searches for it, so either spec finds it.
      data: { name: `Synthetic portal contractor ${suffix}`, userId },
    });
    if (created.ok()) contractor = (await created.json()) as { id: string };
  }
  expect(contractor, "shared subcontractor's contractor").toBeDefined();
  const offer = await write<{ id: string }>(
    page,
    `/api/jobs/${job.id}/offers`,
    {
      contractorId: contractor!.id,
      scope: "Synthetic a11y scope",
      rateType: "fixed",
      rateExclusiveCents: "30000",
      taxCode: "OUT_OF_SCOPE",
    },
  );
  return {
    owner: [
      `/customers/${customer.id}`,
      `/jobs/${job.id}`,
      `/quotes/${quote.id}`,
      `/invoices/${draft.id}`,
      `/payments/receipts/${receipt.id}`,
      `/payments/bills/${bill.id}`,
      `/payments/supplier/${payment.id}`,
      `/expenses/${expense.id}`,
      `/employees/${employee.id}`,
      `/contractors/${contractor!.id}`,
    ],
    subcontractor: [`/offers/${offer.id}`],
  };
}

for (const role of Object.keys(SCREENS) as E2eRole[])
  test(`${role}: every screen passes axe and reflows`, async ({ page }) => {
    let details: string[] = [];
    if (role === "owner" || role === "subcontractor") {
      await signIn(page, "owner");
      details = (await seedDetails(page))[role];
      if (role !== "owner") await page.context().clearCookies();
    }
    if (role !== "owner") await signIn(page, role);
    const problems: string[] = [];
    for (const path of [...SCREENS[role], ...details]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await settled(page, path);
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
    await settled(page, "/home");
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
