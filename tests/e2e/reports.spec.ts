import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { requireAccounts, signIn } from "./accounts";
import { syntheticAbn } from "../helpers/abn";
test.setTimeout(150_000);
test.beforeEach(() => {
  requireAccounts();
});

// Report screens (#58): the accountant inspects GST composition and exports
// it; every state works at phone and desktop widths in both themes.

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
        `${name} ${theme} ${width}`,
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

/** Parse the export's RFC 4180 CSV (quoted text, bare numbers). */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += c;
  }
  const [header, ...body] = rows;
  return body.map((cells) =>
    Object.fromEntries(header!.map((name, i) => [name, cells[i] ?? ""])),
  );
}

test("accountant inspects GST composition, ageing and cash, and exports CSV", async ({
  page,
}, testInfo) => {
  // The owner records the sale; the accountant reviews it.
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
  const name = `Synthetic report customer ${randomUUID().slice(0, 8)}`;
  const customer = await write<{ id: string }>(page, "/api/customers", {
    name,
  });
  // Two jobs, so the profit view's job selector has a choice (#58).
  for (const n of [1, 2])
    await write(page, "/api/jobs", {
      title: `Synthetic reported job ${n}`,
      customerId: customer.id,
    });
  const draft = await write<{ id: string }>(page, "/api/invoices", {
    customerId: customer.id,
    priceEntry: "exclusive",
    lines: [
      {
        description: "Synthetic reported work",
        quantity: "1",
        unitPriceCents: "123400",
        taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
      },
    ],
  });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
  }).format(new Date());
  const issued = await write<{ reference: string }>(
    page,
    `/api/invoices/${draft.id}/issue`,
    { issueDate: today },
  );

  await page.context().clearCookies();
  await signIn(page, "accountant");
  await page.goto("/reports?view=gst");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
  const tabs = page.getByRole("navigation", { name: "Reports" });
  for (const tab of [
    "Job profit",
    "Draft GST",
    "Who owes what",
    "Cash movement",
  ])
    await expect(tabs.getByRole("link", { name: tab })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Draft GST" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("button", { name: "This quarter" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "GST composition" }),
  ).toBeVisible();
  await expect(page.getByText("1A GST on sales").first()).toBeVisible();
  await audit(page, testInfo, "reports-gst");

  // The exported summary is the same as the screen, in machine cents.
  const summaryDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export summary CSV" }).click();
  const summaryFile = await summaryDownload;
  expect(summaryFile.suggestedFilename()).toMatch(
    /^jobflow-gst-summary-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const [summary] = parseCsv(
    await (
      await page.request.get(
        new URL(
          (await page
            .getByRole("link", { name: "Export summary CSV" })
            .getAttribute("href"))!,
          page.url(),
        ).toString(),
      )
    ).text(),
  );
  const json = await (
    await page.request.get(
      new URL(
        (await page
          .getByRole("link", { name: "Export summary CSV" })
          .getAttribute("href"))!.replace(
          "/api/exports/gst-summary",
          "/api/reports/gst",
        ),
        page.url(),
      ).toString(),
    )
  ).json();
  expect(summary).toMatchObject({
    label_1a_gst_on_sales_cents: json.oneA,
    label_1b_gst_on_purchases_cents: json.oneB,
    net_gst_cents: json.netGst,
  });
  expect(summary!.label_1a_gst_on_sales_cents).toMatch(/^-?\d+$/);
  const linesHref = (await page
    .getByRole("link", { name: "Export GST lines CSV" })
    .getAttribute("href"))!;
  const lines = parseCsv(
    await (
      await page.request.get(new URL(linesHref, page.url()).toString())
    ).text(),
  );
  if (registered)
    expect(lines.find((l) => l.source_id === draft.id)).toMatchObject({
      source_type: "invoice",
      source_reference: issued.reference,
      party_name: name,
      bas_label: "1A",
      gst_cents: "12340",
    });

  // A reversed range is refused before anything loads.
  await page.getByLabel("From", { exact: true }).fill("2026-09-30");
  await page.getByLabel("To", { exact: true }).fill("2026-07-01");
  await expect(
    page.getByText("End date must be on or after start date"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Show" })).toBeDisabled();

  // Ageing: the new invoice is owed today, not yet overdue.
  await tabs.getByRole("link", { name: "Who owes what" }).click();
  await expect(page.getByLabel("Show")).toHaveValue("receivables");
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await page.getByLabel("As at the end of").fill("2000-01-01");
  await expect(
    page.getByRole("heading", { name: "Nothing owed" }),
  ).toBeVisible();
  await page.getByLabel("As at the end of").fill(today);
  const owed = (await (
    await page.request.get(
      `/api/reports/ageing?side=receivables&asAt=${today}&pageSize=1000`,
    )
  ).json()) as { rows: { id: string; owed: string; bucket: string }[] };
  expect(owed.rows.find((r) => r.id === draft.id)).toMatchObject({
    owed: registered ? "135740" : "123400",
    bucket: "current",
  });
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await audit(page, testInfo, "reports-ageing");

  await tabs.getByRole("link", { name: "Cash movement" }).click();
  await expect(
    page.getByText("Cash movement — money in less money out, not profit"),
  ).toBeVisible();
  await audit(page, testInfo, "reports-cash");

  await tabs.getByRole("link", { name: "Job profit" }).click();
  await expect(page.getByText("Cash in this range — not profit")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What makes up these figures" }),
  ).toBeVisible();
  await audit(page, testInfo, "reports-profit");

  // Choosing a job keeps every job in the selector, and the export follows
  // the choice (#58).
  const jobSelect = page.getByLabel("Job", { exact: true });
  const options = jobSelect.locator("option");
  await expect(options.nth(2)).toBeAttached();
  const optionCount = await options.count();
  const chosen = (await options.nth(1).getAttribute("value"))!;
  const filtered = page.waitForResponse(
    (r) =>
      r.url().includes("/api/reports/profitability") &&
      r.url().includes(`jobId=${chosen}`),
  );
  await jobSelect.selectOption(chosen);
  await filtered;
  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
    "href",
    new RegExp(`jobId=${chosen}`),
  );
  await expect(options).toHaveCount(optionCount);
});

test("report views follow each role; workers get no reports", async ({
  page,
}) => {
  await signIn(page, "manager");
  await page.goto("/reports?view=gst");
  const tabs = page.getByRole("navigation", { name: "Reports" });
  await expect(tabs.getByRole("link")).toHaveText(["Job profit"]);
  await expect(page.getByRole("link", { name: /Export/ })).toHaveCount(0);
  expect(
    (
      await page.request.get("/api/exports/cash?from=2026-07-01&to=2026-09-30")
    ).status(),
  ).toBe(403);
  for (const role of ["employee", "subcontractor"] as const) {
    await page.context().clearCookies();
    await signIn(page, role);
    expect((await page.goto("/reports"))?.status()).toBe(404);
  }
});
