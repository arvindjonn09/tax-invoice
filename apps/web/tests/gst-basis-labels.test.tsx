import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  companyBasis,
  documentTotalText,
  totalBasis,
} from "@/components/money-display";
import { InvoiceLines } from "@/features/invoices/lines";
import { Totals } from "@/features/invoices/totals";

// #305: "incl GST" only where GST was charged (documents) or could have
// been (a company that has ever been registered). Assertions read the
// markup as rendered; nothing is stripped.

describe("GST basis labels (#305)", () => {
  it("a document total says incl GST only when it charged GST", () => {
    expect(totalBasis("25000")).toBe("incl GST");
    expect(totalBasis(1n)).toBe("incl GST");
    expect(totalBasis("0")).toBe("no GST");
    expect(totalBasis(null)).toBe("no GST");
  });

  it("dialogs, the sticky bar and credit lists use the same text", () => {
    // The issue and send dialogs, the mobile total bar and credit note
    // lists all render documentTotalText.
    expect(documentTotalText("250000", "0")).toBe("$2,500.00 no GST");
    expect(documentTotalText("275000", "25000")).toBe("$2,750.00 incl GST");
    expect(documentTotalText(-110000n, -10000n)).toBe("−$1,100.00 incl GST");
  });

  it("company-wide wording: unchanged once registered", () => {
    expect(companyBasis(true, "sales")).toBe("incl GST");
    expect(companyBasis(true, "mixed")).toBe("incl GST");
    // Never registered: sales carried no GST; supplier amounts may have.
    expect(companyBasis(false, "sales")).toBe("no GST");
    expect(companyBasis(false, "mixed")).toBe("total");
  });

  it("an unregistered invoice's total doesn't say incl GST", () => {
    const html = renderToStaticMarkup(
      <Totals
        totals={{
          exclusiveCents: "250000",
          gstCents: "0",
          inclusiveCents: "250000",
        }}
        stale={false}
        registered={false}
      />,
    );
    expect(html).toContain("$2,500.00 AUD");
    expect(html).toContain(" no GST");
    expect(html).not.toContain("incl GST");
  });

  it("a registered invoice's total is unchanged", () => {
    const html = renderToStaticMarkup(
      <Totals
        totals={{
          exclusiveCents: "250000",
          gstCents: "25000",
          inclusiveCents: "275000",
        }}
        stale={false}
        registered
      />,
    );
    expect(html).toContain("$2,750.00 AUD");
    expect(html).toContain(" incl GST");
  });

  it("each line says incl GST only when that line charged GST", () => {
    const line = (id: string, gst: string, inclusive: string) => ({
      id,
      description: `Line ${id}`,
      quantity: "1",
      unitPriceCents: "10000",
      taxCode: gst === "0" ? "GST_FREE" : "TAXABLE_10",
      exclusiveCents: "10000",
      gstCents: gst,
      inclusiveCents: inclusive,
    });
    const html = renderToStaticMarkup(
      <InvoiceLines
        invoice={
          {
            priceEntry: "exclusive",
            lines: [line("a", "1000", "11000"), line("b", "0", "10000")],
          } as never
        }
      />,
    );
    const [first, second] = html.split("<li").slice(1);
    expect(first).toContain("$110.00 incl GST");
    expect(second).toContain("$100.00 no GST");
    expect(second).not.toContain("incl GST");
  });
});
