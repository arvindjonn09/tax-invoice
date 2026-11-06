import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { companyBasis, totalBasis } from "@/components/money-display";
import { Totals } from "@/features/invoices/totals";

// #305: "incl GST" only where GST was charged (documents) or could have
// been (a company that has ever been registered).
const text = (html: string) => html.replace(/<[^>]+>/g, "");

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
});
