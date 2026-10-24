import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  type InvoicePdfInput,
  aud,
  invoiceDocument,
  longDate,
  renderInvoicePdf,
} from "../src/server/invoices/pdf";
import { syntheticAbn } from "../../../tests/helpers/abn";

// #48 golden files and #70 renderer controls. Synthetic parties only.
const supplier = {
  name: "Sample Sparks",
  legalName: "Sample Sparks Pty Ltd",
  abn: syntheticAbn("484848484"),
  addressLine1: "1 Example Street",
  addressLine2: null,
  suburb: "Sampleville",
  state: "NSW",
  postcode: "2000",
};
const customer = {
  name: "Acme Sample Co",
  abn: syntheticAbn("484848490"),
  billingEmail: "accounts@example.invalid",
  addressLine1: "2 Sample Road",
  addressLine2: "Level 3",
  suburb: "Testtown",
  state: "VIC",
  postcode: "3000",
};

/** docs/GST.md combined fixture: $2,500 ex GST, $250 GST, $2,750. */
const registered: InvoicePdfInput = {
  kind: "invoice",
  title: "Tax Invoice",
  reference: "INV-0042",
  issueDate: "2026-07-15",
  dueOn: "2026-08-14",
  gstRegistered: true,
  priceEntry: "exclusive",
  customerReference: "PO-7781",
  notes: "Thanks for your business.\nPay by bank transfer within 30 days.",
  creditsReference: null,
  supplier,
  customer,
  site: {
    label: "Head office",
    addressLine1: "2 Sample Road",
    suburb: "Testtown",
    state: "VIC",
    postcode: "3000",
  },
  lines: [
    {
      description: "Office electrical fit-out per accepted quote Q-0007",
      quantity: "1",
      unit: null,
      unitPriceCents: 230_000n,
      taxCode: "TAXABLE_10",
      exclusiveCents: 230_000n,
      gstCents: 23_000n,
      inclusiveCents: 253_000n,
    },
    {
      description: "Call-out labour",
      quantity: "2.5",
      unit: "h",
      unitPriceCents: 8_000n,
      taxCode: "TAXABLE_10",
      exclusiveCents: 20_000n,
      gstCents: 2_000n,
      inclusiveCents: 22_000n,
    },
  ],
  exclusiveCents: 250_000n,
  gstCents: 25_000n,
  inclusiveCents: 275_000n,
};

/** Not registered: an ordinary "Invoice" with no GST at all. */
const unregistered: InvoicePdfInput = {
  ...registered,
  title: "Invoice",
  reference: "INV-0043",
  gstRegistered: false,
  site: null,
  notes: null,
  lines: [
    {
      description: "Office electrical fit-out",
      quantity: "1",
      unit: null,
      unitPriceCents: 250_000n,
      taxCode: "OUT_OF_SCOPE",
      exclusiveCents: 250_000n,
      gstCents: 0n,
      inclusiveCents: 250_000n,
    },
  ],
  exclusiveCents: 250_000n,
  gstCents: 0n,
  inclusiveCents: 250_000n,
};

const adjustment: InvoicePdfInput = {
  ...registered,
  kind: "credit_note",
  title: "Adjustment Note",
  reference: "CN-0003",
  dueOn: null,
  creditsReference: "INV-0042",
  customerReference: null,
  notes: null,
  lines: [
    {
      description: "Credit: call-out labour not required",
      quantity: "2.5",
      unit: "h",
      unitPriceCents: 8_000n,
      taxCode: "TAXABLE_10",
      exclusiveCents: 20_000n,
      gstCents: 2_000n,
      inclusiveCents: 22_000n,
    },
  ],
  exclusiveCents: 20_000n,
  gstCents: 2_000n,
  inclusiveCents: 22_000n,
};

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("invoice PDF content (#48 golden files)", () => {
  it("registered tax invoice", async () => {
    const model = invoiceDocument(registered);
    expect(model.totals).toEqual([
      ["Total ex GST", "$2,500.00"],
      ["GST", "$250.00"],
      ["Total incl GST", "$2,750.00"],
    ]);
    expect(model.from).toContain(
      `ABN ${supplier.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4")}`,
    );
    await expect(JSON.stringify(model, null, 2)).toMatchFileSnapshot(
      "golden/invoice-registered.model.json",
    );
  });

  it("not registered: 'Invoice', no GST column or amount", async () => {
    const model = invoiceDocument(unregistered);
    expect(model.title).toBe("Invoice");
    expect(model.columns).not.toContain("GST");
    expect(model.totals).toEqual([["Total", "$2,500.00"]]);
    expect(model.footer.join(" ")).toMatch(/No GST has been charged/);
    await expect(JSON.stringify(model, null, 2)).toMatchFileSnapshot(
      "golden/invoice-unregistered.model.json",
    );
  });

  it("adjustment note names the invoice it adjusts", async () => {
    const model = invoiceDocument(adjustment);
    expect(model.details).toContainEqual(["Adjusts invoice", "INV-0042"]);
    expect(model.totals.at(-1)).toEqual([
      "Total adjustment incl GST",
      "$220.00",
    ]);
    await expect(JSON.stringify(model, null, 2)).toMatchFileSnapshot(
      "golden/adjustment-note.model.json",
    );
  });

  it("renders the same bytes for the same snapshot (regeneration never changes it)", async () => {
    for (const [name, input] of [
      ["registered", registered],
      ["unregistered", unregistered],
      ["adjustment", adjustment],
    ] as const) {
      const first = await renderInvoicePdf(invoiceDocument(input));
      const second = await renderInvoicePdf(invoiceDocument(input));
      expect(sha(first), name).toBe(sha(second));
      expect(latin1(first.subarray(0, 5))).toBe("%PDF-");
      await expect(`${sha(first)}\n`).toMatchFileSnapshot(
        `golden/${name}.pdf.sha256`,
      );
    }
  });

  it("formats money and dates without floating point or locale", () => {
    expect(aud(0n)).toBe("$0.00");
    expect(aud(5n)).toBe("$0.05");
    expect(aud(123_456_789n)).toBe("$1,234,567.89");
    expect(aud(-22_000n)).toBe("-$220.00");
    expect(longDate("2026-07-15")).toBe("15 July 2026");
    expect(longDate("2027-01-01")).toBe("1 January 2027");
  });
});

/** Every drawn text run per page: its baseline y and decoded text. */
async function drawnText(bytes: Uint8Array) {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams =
      contents && "asArray" in contents
        ? contents.asArray()
        : contents
          ? [contents]
          : [];
    const source = streams
      .map((ref) => {
        const stream = document.context.lookup(ref) as unknown as {
          getContents(): Uint8Array;
          dict: { toString(): string };
        };
        const raw = Buffer.from(stream.getContents());
        return stream.dict.toString().includes("FlateDecode")
          ? inflateSync(raw).toString("latin1")
          : raw.toString("latin1");
      })
      .join("\n");
    return [
      ...source.matchAll(
        /1 0 0 1 ([\d.]+) ([\d.-]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g,
      ),
    ].map((match) => ({
      y: Number(match[2]),
      text: Buffer.from(match[3]!, "hex").toString("latin1"),
    }));
  });
}

describe("line descriptions taller than a page (#145 review)", () => {
  it("continue on following pages and never draw below the margin", async () => {
    const entries = Array.from(
      { length: 70 },
      (_, index) => `Entry ${index + 1}`,
    );
    const pages = await drawnText(
      await renderInvoicePdf(
        invoiceDocument({
          ...registered,
          lines: [{ ...registered.lines[0]!, description: entries.join("\n") }],
        }),
      ),
    );
    expect(pages.length).toBeGreaterThan(1);
    for (const runs of pages)
      for (const run of runs) expect(run.y).toBeGreaterThanOrEqual(50);
    const drawn = pages.flat().map((run) => run.text);
    for (const entry of entries) expect(drawn).toContain(entry);
    // Continuation pages repeat the title and the table header.
    for (const runs of pages.slice(1))
      expect(runs.map((run) => run.text)).toContain(
        `${registered.title} (continued)`,
      );
  });
});

describe("renderer controls (#70)", () => {
  const hostile: InvoicePdfInput = {
    ...registered,
    notes:
      '<script>fetch("http://169.254.169.254/latest/meta-data")</script>\u0000\u0007 file:///etc/passwd',
    customerReference: '=HYPERLINK("http://127.0.0.1:9000")',
    customer: {
      ...customer,
      name: '<img src="http://10.0.0.1/x.png" onerror=alert(1)>',
    },
    lines: Array.from({ length: 70 }, (_, index) => ({
      ...registered.lines[1]!,
      description:
        index === 0
          ? `${"A".repeat(400)} 中文 emoji 🔥 Café ${"‮"}gpj.exe`
          : `Synthetic line ${index + 1} <b>bold?</b> \\ ( ) [ ] { }`,
    })),
  };

  it("draws hostile text as text: no links, actions, scripts or embedded files", async () => {
    const started = Date.now();
    const bytes = await renderInvoicePdf(invoiceDocument(hostile));
    expect(Date.now() - started).toBeLessThan(5_000);
    const raw = latin1(bytes);
    for (const marker of [
      "/URI",
      "/JavaScript",
      "/JS",
      "/Launch",
      "/OpenAction",
      "/AA",
      "/EmbeddedFile",
      // Images or form objects (an empty /XObject resource dict is fine).
      "/Subtype /Image",
      "/Subtype /Form",
    ])
      expect(raw.includes(marker), marker).toBe(false);
    // Every page's annotation list (links, widgets) is empty.
    expect(
      raw.match(/\/Annots \[[^\]]*\]/g)?.every((m) => /\[\s*\]/.test(m)),
    ).toBe(true);
    const parsed = await PDFDocument.load(bytes);
    // 70 lines overflow one page; layout continues on further pages.
    expect(parsed.getPageCount()).toBeGreaterThan(1);
    // Only the two built-in fonts are referenced; nothing is loaded.
    expect(raw.match(/\/BaseFont \/[A-Za-z-]+/g)?.sort()).toEqual([
      "/BaseFont /Helvetica",
      "/BaseFont /Helvetica-Bold",
    ]);
  });

  it("keeps the original text in the content model (escaping happens only at draw time)", () => {
    const model = invoiceDocument(hostile);
    expect(model.notes).toContain("<script>");
    expect(model.to[0]).toContain("<img");
  });
});
