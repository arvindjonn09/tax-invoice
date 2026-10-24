import { describe, expect, it } from "vitest";
import {
  RECIPIENT_IDENTITY_THRESHOLD_CENTS,
  creditableRemaining,
  documentTotals,
  invoiceLines,
  invoiceTitle,
  issueProblems,
} from "../src/index";

describe("invoice title and GST (#47)", () => {
  it("fixture: $2,500 ex GST → $250 GST → $2,750 'Tax Invoice' when registered", () => {
    const lines = invoiceLines(
      [
        {
          description: "Install",
          quantity: "1",
          unitPrice: 250_000n,
          taxCode: "TAXABLE_10",
        },
      ],
      "exclusive",
      true,
    );
    expect(documentTotals(lines)).toEqual({
      exclusive: 250_000n,
      gst: 25_000n,
      inclusive: 275_000n,
    });
    expect(invoiceTitle(true)).toBe("Tax Invoice");
  });

  it("not registered: no GST, titled 'Invoice', Taxable lines refused", () => {
    const lines = invoiceLines(
      [
        {
          description: "Install",
          quantity: "1",
          unitPrice: 250_000n,
          taxCode: "OUT_OF_SCOPE",
        },
      ],
      "exclusive",
      false,
    );
    expect(documentTotals(lines)).toEqual({
      exclusive: 250_000n,
      gst: 0n,
      inclusive: 250_000n,
    });
    expect(invoiceTitle(false)).toBe("Invoice");
    expect(() =>
      invoiceLines(
        [
          {
            description: "x",
            quantity: "1",
            unitPrice: 1n,
            taxCode: "TAXABLE_10",
          },
        ],
        "exclusive",
        false,
      ),
    ).toThrow(RangeError);
  });

  it("mixed tax codes, inclusive entry and quantities round per line", () => {
    const lines = invoiceLines(
      [
        {
          description: "Labour",
          quantity: "2.5",
          unitPrice: 11_000n,
          taxCode: "TAXABLE_10",
        },
        {
          description: "Food",
          quantity: "3",
          unitPrice: 333n,
          taxCode: "GST_FREE",
        },
        {
          description: "Rent",
          quantity: "1",
          unitPrice: 1_000n,
          taxCode: "INPUT_TAXED",
        },
      ],
      "inclusive",
      true,
    );
    expect(lines.map((l) => [l.exclusive, l.gst, l.inclusive])).toEqual([
      [25_000n, 2_500n, 27_500n],
      [999n, 0n, 999n],
      [1_000n, 0n, 1_000n],
    ]);
  });
});

describe("issue validation", () => {
  const base = {
    registered: true,
    supplier: { legalName: "Sample Pty Ltd", abn: "12345678901" },
    recipient: { name: "Acme Sample", abn: null },
    lines: [
      {
        description: "Install",
        quantity: "1",
        unitPrice: 1n,
        taxCode: "TAXABLE_10" as const,
      },
    ],
    inclusive: 110n,
  };

  it("passes a complete tax invoice", () => {
    expect(issueProblems(base)).toEqual([]);
  });

  it("needs lines with descriptions, and supplier legal name + ABN when registered", () => {
    expect(issueProblems({ ...base, lines: [] }).map((p) => p.field)).toEqual([
      "lines",
    ]);
    expect(
      issueProblems({
        ...base,
        lines: [{ ...base.lines[0]!, description: "  " }],
      }).map((p) => p.field),
    ).toEqual(["lines.0.description"]);
    expect(
      issueProblems({ ...base, supplier: { legalName: " ", abn: null } }).map(
        (p) => p.field,
      ),
    ).toEqual(["company.legalName", "company.abn"]);
  });

  it("identifies the recipient on tax invoices of $1,000 or more", () => {
    const big = { ...base, inclusive: RECIPIENT_IDENTITY_THRESHOLD_CENTS };
    expect(
      issueProblems({ ...big, recipient: { name: " ", abn: null } }).map(
        (p) => p.field,
      ),
    ).toEqual(["customer"]);
    expect(
      issueProblems({ ...big, recipient: { name: null, abn: "12345678901" } }),
    ).toEqual([]);
    expect(
      issueProblems({
        ...big,
        inclusive: RECIPIENT_IDENTITY_THRESHOLD_CENTS - 1n,
        recipient: { name: null, abn: null },
      }),
    ).toEqual([]);
  });

  it("an unregistered company needs no ABN but can't charge GST", () => {
    const plain = {
      ...base,
      registered: false,
      supplier: { legalName: null, abn: null },
      recipient: { name: null, abn: null },
      inclusive: 500_000n,
    };
    expect(issueProblems(plain).map((p) => p.field)).toEqual([
      "lines.0.taxCode",
    ]);
    expect(
      issueProblems({
        ...plain,
        lines: [{ ...base.lines[0]!, taxCode: "OUT_OF_SCOPE" }],
      }),
    ).toEqual([]);
  });
});

describe("credit limit", () => {
  it("never lets credits exceed the invoice", () => {
    expect(creditableRemaining(275_000n, [])).toBe(275_000n);
    expect(creditableRemaining(275_000n, [100_000n, 75_000n])).toBe(100_000n);
    expect(creditableRemaining(275_000n, [300_000n])).toBe(0n);
  });
});
