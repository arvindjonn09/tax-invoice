import { formatAbn } from "@jobflow/domain";
import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";

// #48 invoice and credit-note PDFs, with #70's renderer controls built in:
// pdf-lib draws text with the built-in standard fonts only. It never parses
// HTML, runs scripts, loads fonts or images, or fetches any URL or file, so
// customer-supplied text can't trigger requests, script or local reads; it is
// only ever drawn as text. Same snapshot in → same bytes out.

/** Bump when the layout changes; stored with each generated PDF. */
export const PDF_RENDERER_VERSION = "1";

type Party = {
  name?: string | null;
  legalName?: string | null;
  label?: string | null;
  abn?: string | null;
  billingEmail?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
};

export type InvoicePdfInput = {
  kind: "invoice" | "credit_note";
  title: string;
  reference: string;
  issueDate: string;
  dueOn: string | null;
  gstRegistered: boolean;
  priceEntry: "exclusive" | "inclusive";
  customerReference: string | null;
  notes: string | null;
  /** The invoice a credit note adjusts. */
  creditsReference: string | null;
  supplier: Party;
  customer: Party;
  site: Party | null;
  lines: {
    description: string;
    quantity: string;
    unit: string | null;
    unitPriceCents: bigint;
    taxCode: string;
    exclusiveCents: bigint;
    gstCents: bigint;
    inclusiveCents: bigint;
  }[];
  exclusiveCents: bigint;
  gstCents: bigint;
  inclusiveCents: bigint;
};

/** Everything the PDF shows, as plain strings: what golden files capture. */
export type InvoiceDocumentModel = {
  title: string;
  details: [string, string][];
  from: string[];
  to: string[];
  site: string[] | null;
  columns: string[];
  rows: string[][];
  totals: [string, string][];
  notes: string | null;
  footer: string[];
  metadata: { title: string; date: string };
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-07-15" → "15 July 2026", with no locale or time-zone dependence. */
export function longDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${date} ${MONTHS[month! - 1]} ${year}`;
}

/** Integer cents → "$1,234.56" without floating point. */
export function aud(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = (absolute / 100n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

const TAX_LABEL: Record<string, string> = {
  TAXABLE_10: "GST 10%",
  GST_FREE: "GST-free",
  INPUT_TAXED: "Input taxed",
  OUT_OF_SCOPE: "No GST",
};

function address(party: Party): string[] {
  const place = [party.suburb, party.state, party.postcode]
    .filter(Boolean)
    .join(" ");
  return [party.addressLine1, party.addressLine2, place].filter(
    (line): line is string => Boolean(line),
  );
}

/** The document's content, independent of fonts and page geometry. */
export function invoiceDocument(input: InvoicePdfInput): InvoiceDocumentModel {
  const registered = input.gstRegistered;
  const details: [string, string][] = [
    [input.kind === "invoice" ? "Invoice number" : "Number", input.reference],
    ["Date", longDate(input.issueDate)],
  ];
  if (input.dueOn) details.push(["Due", longDate(input.dueOn)]);
  if (input.creditsReference)
    details.push(["Adjusts invoice", input.creditsReference]);
  if (input.customerReference)
    details.push(["Your reference", input.customerReference]);

  const supplier = input.supplier;
  const from = [
    supplier.legalName ?? supplier.name ?? "",
    ...(supplier.legalName &&
    supplier.name &&
    supplier.name !== supplier.legalName
      ? [`Trading as ${supplier.name}`]
      : []),
    ...(supplier.abn ? [`ABN ${formatAbn(supplier.abn)}`] : []),
    ...address(supplier),
  ].filter(Boolean);
  const customer = input.customer;
  const to = [
    customer.name ?? "",
    ...(customer.abn ? [`ABN ${formatAbn(customer.abn)}`] : []),
    ...address(customer),
    ...(customer.billingEmail ? [customer.billingEmail] : []),
  ].filter(Boolean);
  const site = input.site
    ? [input.site.label ?? "", ...address(input.site)].filter(Boolean)
    : null;

  const columns = registered
    ? ["Description", "Qty", "Unit price", "Tax", "GST", "Incl GST"]
    : ["Description", "Qty", "Unit price", "Amount"];
  const rows = input.lines.map((line) => {
    const quantity = line.unit
      ? `${line.quantity} ${line.unit}`
      : line.quantity;
    return registered
      ? [
          line.description,
          quantity,
          aud(line.unitPriceCents),
          TAX_LABEL[line.taxCode] ?? line.taxCode,
          aud(line.gstCents),
          aud(line.inclusiveCents),
        ]
      : [
          line.description,
          quantity,
          aud(line.unitPriceCents),
          aud(line.inclusiveCents),
        ];
  });
  const totals: [string, string][] = registered
    ? [
        ["Total ex GST", aud(input.exclusiveCents)],
        ["GST", aud(input.gstCents)],
        [
          input.kind === "invoice"
            ? "Total incl GST"
            : "Total adjustment incl GST",
          aud(input.inclusiveCents),
        ],
      ]
    : [
        [
          input.kind === "invoice" ? "Total" : "Total credit",
          aud(input.inclusiveCents),
        ],
      ];

  const footer = registered
    ? [
        input.priceEntry === "inclusive"
          ? "Unit prices include GST."
          : "Unit prices exclude GST.",
        input.lines.some((line) => line.taxCode !== "TAXABLE_10")
          ? "Items marked GST 10% are taxable supplies; other items carry no GST."
          : "All items are taxable supplies.",
      ]
    : ["No GST has been charged. The supplier is not registered for GST."];
  return {
    title: input.title,
    details,
    from,
    to,
    site,
    columns,
    rows,
    totals,
    notes: input.notes,
    footer,
    metadata: {
      title: `${input.title} ${input.reference}`,
      date: input.issueDate,
    },
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.82, 0.84, 0.87);

/**
 * Text the standard (WinAnsi) font can draw: control characters become
 * spaces; anything else outside its character set falls back to its base
 * letter (é → e) or "?". Nothing is ever interpreted, only drawn.
 */
function drawable(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a) {
      out += "\n";
    } else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      out += " ";
    } else if (supported.has(code)) {
      out += char;
    } else {
      const base = char.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      out += [...base].every((c) => supported.has(c.codePointAt(0)!))
        ? base
        : "?";
    }
  }
  return out;
}

/** Greedy word wrap to `width`; long words are broken by character. */
function wrap(font: PDFFont, size: number, text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let cut = rest.length;
        while (
          cut > 1 &&
          font.widthOfTextAtSize(rest.slice(0, cut), size) > width
        )
          cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

export async function renderInvoicePdf(
  model: InvoiceDocumentModel,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  // Fixed metadata so the same snapshot always produces the same bytes.
  const date = new Date(`${model.metadata.date}T00:00:00Z`);
  pdf.setTitle(drawableAscii(model.metadata.title));
  pdf.setProducer("JobFlow");
  pdf.setCreator("JobFlow");
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = A4[0] - MARGIN * 2;
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - MARGIN;

  const text = (
    value: string,
    x: number,
    options: {
      size?: number;
      font?: PDFFont;
      color?: typeof INK;
      align?: "left" | "right";
      maxWidth?: number;
    } = {},
  ) => {
    const font = options.font ?? regular;
    const size = options.size ?? 9;
    const safe = drawable(font, value);
    const shown =
      options.maxWidth !== undefined
        ? (wrap(font, size, safe, options.maxWidth)[0] ?? "")
        : safe;
    const left =
      options.align === "right" ? x - font.widthOfTextAtSize(shown, size) : x;
    page.drawText(shown, {
      x: left,
      y,
      size,
      font,
      color: options.color ?? INK,
    });
  };
  const newPage = () => {
    page = pdf.addPage(A4);
    y = A4[1] - MARGIN;
    text(`${model.title} (continued)`, MARGIN, { font: bold, size: 11 });
    y -= 24;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 30) newPage();
  };

  // Title and document details.
  text(model.title, MARGIN, { font: bold, size: 22 });
  let detailY = y;
  for (const [label, value] of model.details) {
    const saved = y;
    y = detailY;
    text(label, A4[0] - MARGIN - 150, { color: MUTED });
    text(value, A4[0] - MARGIN, { align: "right", font: bold, maxWidth: 140 });
    y = saved;
    detailY -= 13;
  }
  y = Math.min(y - 34, detailY - 10);

  // Parties.
  const columnWidth = (width - 20) / (model.site ? 3 : 2);
  const blocks: [string, string[]][] = [
    ["From", model.from],
    ["To", model.to],
    ...(model.site ? ([["Site", model.site]] as [string, string[]][]) : []),
  ];
  const top = y;
  let lowest = y;
  blocks.forEach(([label, lines], index) => {
    y = top;
    const x = MARGIN + index * (columnWidth + 10);
    text(label.toUpperCase(), x, { color: MUTED, size: 8, font: bold });
    y -= 13;
    for (const line of lines) {
      for (const part of wrap(
        regular,
        9,
        drawable(regular, line),
        columnWidth,
      )) {
        text(part, x, {
          font: index === 0 && line === lines[0] ? bold : regular,
        });
        y -= 12;
      }
    }
    lowest = Math.min(lowest, y);
  });
  y = lowest - 14;

  // Line items.
  const numeric = model.columns.length - 2;
  const numberWidth = 72;
  const descriptionWidth = width - 40 - numberWidth * numeric;
  const positions = [
    MARGIN,
    MARGIN + descriptionWidth + 40,
    ...Array.from(
      { length: numeric },
      (_, i) => MARGIN + descriptionWidth + 40 + numberWidth * (i + 1),
    ),
  ];
  const header = () => {
    page.drawLine({
      start: { x: MARGIN, y: y + 12 },
      end: { x: A4[0] - MARGIN, y: y + 12 },
      thickness: 0.6,
      color: RULE,
    });
    model.columns.forEach((column, index) => {
      text(column, index === 0 ? positions[0]! : positions[index]!, {
        font: bold,
        size: 8,
        color: MUTED,
        align: index === 0 ? "left" : "right",
        ...(index === 0
          ? {}
          : { maxWidth: index === 1 ? 38 : numberWidth - 4 }),
      });
    });
    y -= 8;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4[0] - MARGIN, y },
      thickness: 0.6,
      color: RULE,
    });
    y -= 13;
  };
  header();
  for (const row of model.rows) {
    const description = wrap(
      regular,
      9,
      drawable(regular, row[0]!),
      descriptionWidth,
    );
    // Keep a row together when it fits on a page; a taller description
    // starts here and continues on following pages under a repeated header.
    const height = description.length * 12 + 6;
    ensure(height <= A4[1] - MARGIN * 2 - 90 ? height : 30);
    if (y > A4[1] - MARGIN - 40) header();
    const rowTop = y;
    row.slice(1).forEach((cell, index) => {
      y = rowTop;
      text(cell, positions[index + 1]!, { align: "right" });
    });
    y = rowTop;
    for (const part of description) {
      if (y - 12 < MARGIN + 30) {
        newPage();
        header();
      }
      text(part, MARGIN);
      y -= 12;
    }
    y -= 4;
  }

  // Totals.
  ensure(model.totals.length * 15 + 20);
  page.drawLine({
    start: { x: A4[0] - MARGIN - 220, y: y + 6 },
    end: { x: A4[0] - MARGIN, y: y + 6 },
    thickness: 0.6,
    color: RULE,
  });
  y -= 8;
  model.totals.forEach(([label, value], index) => {
    const last = index === model.totals.length - 1;
    const font = last ? bold : regular;
    const size = last ? 11 : 9;
    text(label, A4[0] - MARGIN - 220, { font, size });
    text(value, A4[0] - MARGIN, { font, size, align: "right" });
    y -= last ? 18 : 14;
  });

  // Notes and footer.
  if (model.notes) {
    const lines = wrap(regular, 9, drawable(regular, model.notes), width);
    ensure(lines.length * 12 + 24);
    y -= 10;
    text("Notes", MARGIN, { font: bold, size: 9 });
    y -= 13;
    for (const line of lines) {
      ensure(14);
      text(line, MARGIN);
      y -= 12;
    }
  }
  for (const line of model.footer) {
    ensure(20);
    y -= 8;
    text(line, MARGIN, { color: MUTED, size: 8 });
    y -= 10;
  }
  return pdf.save({ useObjectStreams: false });
}

/** Metadata strings stay plain ASCII. */
function drawableAscii(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
}

/** The PDF input from an issued (or void) invoice's frozen snapshot. */
export function pdfInput(
  row: {
    kind: "invoice" | "credit_note";
    title: string | null;
    reference: string | null;
    issueDate: Date | null;
    dueOn: Date | null;
    gstRegistered: boolean | null;
    priceEntry: "exclusive" | "inclusive";
    customerReference: string | null;
    notes: string | null;
    supplierSnapshot: unknown;
    customerSnapshot: unknown;
    siteSnapshot: unknown;
    exclusiveCents: bigint;
    gstCents: bigint;
    inclusiveCents: bigint;
    items: {
      position: number;
      description: string;
      quantity: string;
      unit: string | null;
      unitPriceCents: bigint;
      taxCode: string;
      exclusiveCents: bigint;
      gstCents: bigint;
      inclusiveCents: bigint;
    }[];
  },
  creditsReference: string | null,
): InvoicePdfInput {
  if (
    !row.title ||
    !row.reference ||
    !row.issueDate ||
    row.gstRegistered === null
  )
    throw new Error("Only an issued document has a PDF");
  const day = (value: Date) => value.toISOString().slice(0, 10);
  return {
    kind: row.kind,
    title: row.title,
    reference: row.reference,
    issueDate: day(row.issueDate),
    dueOn: row.dueOn ? day(row.dueOn) : null,
    gstRegistered: row.gstRegistered,
    priceEntry: row.priceEntry,
    customerReference: row.customerReference,
    notes: row.notes,
    creditsReference,
    supplier: (row.supplierSnapshot ?? {}) as Party,
    customer: (row.customerSnapshot ?? {}) as Party,
    site: (row.siteSnapshot ?? null) as Party | null,
    lines: [...row.items]
      .sort((a, b) => a.position - b.position)
      .map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unitPriceCents: item.unitPriceCents,
        taxCode: item.taxCode,
        exclusiveCents: item.exclusiveCents,
        gstCents: item.gstCents,
        inclusiveCents: item.inclusiveCents,
      })),
    exclusiveCents: row.exclusiveCents,
    gstCents: row.gstCents,
    inclusiveCents: row.inclusiveCents,
  };
}
