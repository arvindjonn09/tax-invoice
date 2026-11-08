import { deflateSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { snapshotLogo } from "../src/server/company/supplier-snapshot";
import {
  type InvoicePdfInput,
  PDF_RENDERER_VERSION,
  invoiceDocument,
  renderInvoicePdf,
} from "../src/server/invoices/pdf";
import { syntheticAbn } from "../../../tests/helpers/abn";

// #229: supplier snapshot v2 in the PDF. Synthetic parties only.
const v1 = {
  name: "Sample Sparks",
  legalName: "Sample Sparks Pty Ltd",
  abn: syntheticAbn("484848484"),
  addressLine1: "1 Example Street",
  addressLine2: null,
  suburb: "Sampleville",
  state: "NSW",
  postcode: "2000",
};
const input = (supplier: InvoicePdfInput["supplier"]): InvoicePdfInput => ({
  kind: "invoice",
  title: "Tax Invoice",
  reference: "INV-0229",
  issueDate: "2026-07-15",
  dueOn: null,
  gstRegistered: true,
  priceEntry: "exclusive",
  customerReference: null,
  notes: null,
  creditsReference: null,
  supplier,
  customer: { name: "Acme Sample Co" },
  site: null,
  lines: [
    {
      description: "Synthetic work",
      quantity: "1",
      unit: null,
      unitPriceCents: 10000n,
      taxCode: "TAXABLE_10",
      exclusiveCents: 10000n,
      gstCents: 1000n,
      inclusiveCents: 11000n,
    },
  ],
  exclusiveCents: 10000n,
  gstCents: 1000n,
  inclusiveCents: 11000n,
});

function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("supplier snapshot v2 in the invoice PDF (#229)", () => {
  it("renders a v1 snapshot exactly as before", () => {
    expect(invoiceDocument(input(v1)).from).toEqual([
      "Sample Sparks Pty Ltd",
      "Trading as Sample Sparks",
      expect.stringMatching(/^ABN /),
      "1 Example Street",
      "Sampleville NSW 2000",
    ]);
  });

  it("adds contact details from v2, each only when recorded", () => {
    const full = invoiceDocument(
      input({
        ...v1,
        phone: "02 5550 0101",
        businessEmail: "accounts@sample.invalid",
        website: "https://sample.invalid",
      }),
    ).from;
    expect(full.slice(-3)).toEqual([
      "Phone 02 5550 0101",
      "accounts@sample.invalid",
      "https://sample.invalid",
    ]);
    const partial = invoiceDocument(
      input({
        ...v1,
        phone: null,
        businessEmail: "",
        website: "https://s.invalid",
      }),
    ).from;
    expect(partial.at(-1)).toBe("https://s.invalid");
    expect(partial.some((line) => line.startsWith("Phone"))).toBe(false);
  });

  it("embeds the logo it's given, deterministically, and bumps the version", async () => {
    expect(PDF_RENDERER_VERSION).toBe("2");
    const model = invoiceDocument(input(v1));
    const logo = { bytes: png(400, 100), type: "image/png" as const };
    const first = await renderInvoicePdf(model, {}, undefined, logo);
    const second = await renderInvoicePdf(model, {}, undefined, logo);
    expect(Buffer.compare(first, second)).toBe(0);
    expect(latin1(first)).toMatch(/\/Subtype \/Image[\s\S]*?\/Width 400/);
    const plain = await renderInvoicePdf(model);
    expect(latin1(plain)).not.toContain("/Subtype /Image");
  });

  it("leaves out a logo it can't read instead of failing", async () => {
    const pdf = await renderInvoicePdf(
      invoiceDocument(input(v1)),
      {},
      undefined,
      { bytes: new Uint8Array([1, 2, 3]), type: "image/png" },
    );
    expect(latin1(pdf)).not.toContain("/Subtype /Image");
  });
});

describe("snapshotLogo (#229)", () => {
  const logo = {
    documentId: "d",
    sha256: "a".repeat(64),
    contentType: "image/png",
  };
  it("reads a v2 snapshot's logo", () => {
    expect(snapshotLogo({ v: 2, logo })).toEqual(logo);
  });
  it("ignores v1, missing or malformed logos", () => {
    expect(snapshotLogo(null)).toBeNull();
    expect(snapshotLogo("x")).toBeNull();
    expect(snapshotLogo({ ...v1 })).toBeNull();
    expect(snapshotLogo({ v: 1, logo })).toBeNull();
    expect(snapshotLogo({ v: 2, logo: null })).toBeNull();
    expect(snapshotLogo({ v: 2, logo: { documentId: 1 } })).toBeNull();
  });
});
