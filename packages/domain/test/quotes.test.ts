import { describe, expect, it } from "vitest";
import {
  acceptProblem,
  invoiceLines,
  quoteEstimate,
  quoteState,
  revenueAfterAcceptance,
} from "../src/index";

describe("quotes (#44)", () => {
  it("estimates revenue and profit ex GST (docs/GST.md fixture)", () => {
    // $2,500 ex GST quoted; estimated costs 900 + 300 + 150 + 100.
    const lines = invoiceLines(
      [
        {
          description: "Synthetic fit-out",
          quantity: "1",
          unitPrice: 250_000n,
          taxCode: "TAXABLE_10",
        },
      ],
      "exclusive",
      true,
    );
    expect(quoteEstimate(lines, [90_000n, 30_000n, 15_000n, 10_000n])).toEqual({
      exclusive: 250_000n,
      gst: 25_000n,
      inclusive: 275_000n,
      estimatedCost: 145_000n,
      estimatedProfit: 105_000n,
      marginBasisPoints: 4_200n,
    });
    // Not registered: same revenue and profit; no GST at all.
    const plain = invoiceLines(
      [
        {
          description: "Synthetic fit-out",
          quantity: "1",
          unitPrice: 250_000n,
          taxCode: "OUT_OF_SCOPE",
        },
      ],
      "exclusive",
      false,
    );
    expect(quoteEstimate(plain, [145_000n])).toMatchObject({
      exclusive: 250_000n,
      gst: 0n,
      estimatedProfit: 105_000n,
      marginBasisPoints: 4_200n,
    });
  });

  it("GST-inclusive entry: revenue is still the exclusive amount", () => {
    const lines = invoiceLines(
      [
        {
          description: "Inclusive price",
          quantity: "2",
          unitPrice: 55_000n,
          taxCode: "TAXABLE_10",
        },
      ],
      "inclusive",
      true,
    );
    const estimate = quoteEstimate(lines, [50_000n]);
    expect(estimate).toMatchObject({
      exclusive: 100_000n,
      gst: 10_000n,
      inclusive: 110_000n,
      estimatedProfit: 50_000n,
    });
    expect(quoteEstimate([], [])).toMatchObject({
      exclusive: 0n,
      marginBasisPoints: null,
    });
    expect(() => quoteEstimate(lines, [-1n])).toThrow(RangeError);
  });

  it("derives expiry from the validity date", () => {
    expect(quoteState("sent", "2026-07-31", "2026-07-31")).toBe("sent");
    expect(quoteState("sent", "2026-07-31", "2026-08-01")).toBe("expired");
    expect(quoteState("sent", null, "2099-01-01")).toBe("sent");
    expect(quoteState("accepted", "2026-07-31", "2026-08-01")).toBe("accepted");
  });

  it("accepts only sent, unexpired quotes for jobs that can take them", () => {
    const base = {
      status: "sent" as const,
      validUntil: "2026-07-31",
      today: "2026-07-15",
      kind: "quote" as const,
      jobStatus: null,
    };
    expect(acceptProblem(base)).toBeNull();
    expect(acceptProblem({ ...base, jobStatus: "quoted" })).toBeNull();
    expect(acceptProblem({ ...base, status: "draft" })).toMatch(/Send/);
    for (const status of ["accepted", "declined", "superseded"] as const)
      expect(acceptProblem({ ...base, status })).toMatch(/can't be accepted/);
    expect(acceptProblem({ ...base, today: "2026-08-01" })).toMatch(/expired/);
    expect(acceptProblem({ ...base, jobStatus: "approved" })).toMatch(
      /variation/,
    );
    const variation = { ...base, kind: "variation" as const };
    expect(
      acceptProblem({ ...variation, jobStatus: "in_progress" }),
    ).toBeNull();
    expect(acceptProblem(variation)).toMatch(/needs its job/);
    for (const jobStatus of ["draft", "quoted", "closed", "cancelled"])
      expect(acceptProblem({ ...variation, jobStatus })).toMatch(
        /approved, open jobs/,
      );
  });

  it("a quote sets the job's estimated revenue; a variation adds to it", () => {
    expect(revenueAfterAcceptance(null, "quote", 250_000n)).toBe(250_000n);
    expect(revenueAfterAcceptance(1n, "quote", 250_000n)).toBe(250_000n);
    expect(revenueAfterAcceptance(250_000n, "variation", 30_000n)).toBe(
      280_000n,
    );
    expect(revenueAfterAcceptance(null, "variation", 30_000n)).toBe(30_000n);
    expect(() => revenueAfterAcceptance(null, "quote", -1n)).toThrow(
      RangeError,
    );
  });
});
