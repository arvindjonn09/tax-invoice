import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { companyBasis, totalBasis } from "@/components/money-display";
import { InvoiceLines } from "@/features/invoices/lines";
import { Totals } from "@/features/invoices/totals";
import type { Invoice } from "@/features/invoices/types";

// #305: "incl GST" only where GST was charged (documents) or could have
// been (a company that has ever been registered).
const text = (html: string) => {
  let out = "";
  let inTag = false;
  for (const character of html) {
    if (character === "<") inTag = true;
    else if (character === ">") inTag = false;
    else if (!inTag) out += character;
  }
  return out;
};

describe("GST basis labels (#305)", () => {
  it("a document total says incl GST only when it charged GST", () => {
    expect(totalBasis("25000")).toBe("incl GST");
    expect(totalBasis(1n)).toBe("incl GST");
    expect(totalBasis("0")).toBe("no GST");
    expect(totalBasis(null)).toBe("no GST");
  });

  it("company-wide wording: unchanged once registered", () => {
    expect(companyBasis(true, "sales")).toBe("incl GST");
    expect(companyBasis(true, "mixed")).toBe("incl GST");
    // Never registered: sales carried no GST; supplier amounts may have.
    expect(companyBasis(false, "sales")).toBe("no GST");
    expect(companyBasis(false, "mixed")).toBe("total");
  });

  it("an unregistered invoice's total doesn't say incl GST", () => {
    const html = text(
      renderToStaticMarkup(
        <Totals
          totals={{
            exclusiveCents: "250000",
            gstCents: "0",
            inclusiveCents: "250000",
          }}
          stale={false}
          registered={false}
        />,
      ),
    );
    expect(html).toContain("$2,500.00 AUD no GST");
    expect(html).not.toContain("incl GST");
  });

  it("a registered invoice's total is unchanged", () => {
    const html = text(
      renderToStaticMarkup(
        <Totals
          totals={{
            exclusiveCents: "250000",
            gstCents: "25000",
            inclusiveCents: "275000",
          }}
          stale={false}
          registered
        />,
      ),
    );
    expect(html).toContain("$2,750.00 AUD incl GST");
  });

  const line = (gstCents: string, inclusiveCents: string) =>
    ({
      description: "Synthetic work",
      quantityThousandths: "1000",
      unitPriceCents: "100000",
      taxCode: "taxable",
      exclusiveCents: "100000",
      gstCents,
      inclusiveCents,
    }) as unknown as Invoice["lines"][number];

  it("an invoice line says incl GST only when it charged GST", () => {
    const html = text(
      renderToStaticMarkup(
        <InvoiceLines
          invoice={{
            priceEntry: "exclusive",
            lines: [line("0", "100000"), line("10000", "110000")],
          }}
        />,
      ),
    );
    expect(html).toContain("$1,000.00 no GST");
    expect(html).toContain("$1,100.00 incl GST");
  });
});
