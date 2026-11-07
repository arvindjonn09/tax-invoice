import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { unregisteredGstProblems } from "@/features/invoices/gst-problems";
import { Totals } from "@/features/invoices/totals";
import { QuoteSummary } from "@/features/quotes/summary";
import type { Quote } from "@/features/quotes/types";

// #302: a draft priced as if registered must not say "No GST charged" (or
// "No problems") while its total includes GST on an unregistered date.
// The owner's example: a $7,242.03 total including $658.37 of GST.
const priced = {
  exclusiveCents: "658366",
  gstCents: "65837",
  inclusiveCents: "724203",
};
const text = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("draft totals add up (#302)", () => {
  it("invoice: shows the GST in the total and warns when unregistered", () => {
    const html = text(
      renderToStaticMarkup(
        <Totals totals={priced} stale={false} registered={false} />,
      ),
    );
    expect(html).not.toContain("No GST charged");
    expect(html).toContain("$6,583.66");
    expect(html).toContain("$658.37 AUD");
    expect(html).toContain("$7,242.03");
    expect(html).toMatch(
      /includes GST from Taxable lines.*isn't registered for GST on the issue date/,
    );
    // 6,583.66 + 658.37 = 7,242.03: what's on screen adds up.
    expect(BigInt(priced.exclusiveCents) + BigInt(priced.gstCents)).toBe(
      BigInt(priced.inclusiveCents),
    );
  });

  it("invoice: nil GST while unregistered still reads No GST charged", () => {
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
    expect(html).toContain("No GST charged");
    expect(html).not.toContain("includes GST from Taxable lines");
  });

  it("invoice: registered (including backdated) shows the GST, no warning", () => {
    const html = text(
      renderToStaticMarkup(<Totals totals={priced} stale={false} registered />),
    );
    expect(html).toContain("$658.37 AUD");
    expect(html).not.toContain("includes GST from Taxable lines");
  });

  const quote = (gstRegistered: boolean | null) =>
    ({
      ...priced,
      gstRegistered,
      estimate: {
        revenueExclusiveCents: priced.exclusiveCents,
        costCents: "0",
        profitCents: priced.exclusiveCents,
        marginBasisPoints: 10000,
      },
    }) as unknown as Quote;

  it("quote draft: unregistered send date shows the GST and warns", () => {
    const html = text(
      renderToStaticMarkup(
        <QuoteSummary quote={quote(null)} stale={false} registered={false} />,
      ),
    );
    expect(html).not.toContain("No GST charged");
    expect(html).toContain("$658.37 AUD");
    expect(html).toMatch(/isn't registered for GST on the send date/);
  });

  it("sent quote: uses its own registration", () => {
    const sent = text(
      renderToStaticMarkup(
        <QuoteSummary
          quote={
            {
              ...quote(false),
              gstCents: "0",
              inclusiveCents: priced.exclusiveCents,
            } as Quote
          }
          stale={false}
        />,
      ),
    );
    expect(sent).toContain("No GST charged");
    expect(
      text(
        renderToStaticMarkup(
          <QuoteSummary quote={quote(true)} stale={false} />,
        ),
      ),
    ).toContain("$658.37 AUD");
  });
});

describe("unregistered GST problems (#302)", () => {
  const lines = [
    { taxCode: "TAXABLE_10" },
    { taxCode: "GST_FREE" },
    { taxCode: "TAXABLE_10" },
  ];
  it("links each Taxable line's GST field when unregistered", () => {
    expect(
      unregisteredGstProblems(lines, false, "2026-07-01", "issue"),
    ).toEqual({
      "lines.0.taxCode": expect.stringMatching(
        /^Line 1 is Taxable, but the company isn't registered for GST on 2026-07-01\. .*issue on a date in a registered period\.$/,
      ),
      "lines.2.taxCode": expect.stringMatching(/^Line 3 is Taxable/),
    });
    expect(
      unregisteredGstProblems(lines, false, "2026-07-01", "send")[
        "lines.0.taxCode"
      ],
    ).toMatch(/send on a date in a registered period/);
  });
  it("is empty when registered on the date (backdating works)", () => {
    expect(unregisteredGstProblems(lines, true, "2026-07-01", "issue")).toEqual(
      {},
    );
  });
  it("is empty when no line is Taxable", () => {
    expect(
      unregisteredGstProblems(
        [{ taxCode: "OUT_OF_SCOPE" }],
        false,
        "2026-07-01",
        "issue",
      ),
    ).toEqual({});
  });
});
