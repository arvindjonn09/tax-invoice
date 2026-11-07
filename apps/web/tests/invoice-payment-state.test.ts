import { describe, expect, it } from "vitest";
import { paymentState } from "@/features/invoices/payment-state";

// #304: the invoice list says Unpaid, Part paid or Paid, with what's owing.
const issued = (fields: {
  receivedCents?: string;
  creditedCents?: string;
  outstandingCents?: string;
}) => ({
  kind: "invoice" as const,
  status: "issued" as const,
  inclusiveCents: "275000",
  ...fields,
});

describe("invoice payment state (#304)", () => {
  it("unpaid: nothing received, the whole total owing", () => {
    expect(
      paymentState(
        issued({
          receivedCents: "0",
          creditedCents: "0",
          outstandingCents: "275000",
        }),
      ),
    ).toEqual({ label: "Unpaid", owingCents: 275000n });
  });
  it("part paid: the $1,000 fixture receipt leaves $1,750 owing", () => {
    expect(
      paymentState(
        issued({
          receivedCents: "100000",
          creditedCents: "0",
          outstandingCents: "175000",
        }),
      ),
    ).toEqual({ label: "Part paid", owingCents: 175000n });
  });
  it("paid in full", () => {
    expect(
      paymentState(
        issued({
          receivedCents: "275000",
          creditedCents: "0",
          outstandingCents: "0",
        }),
      ),
    ).toEqual({ label: "Paid" });
  });
  it("part credited, part paid: paid once nothing is owed", () => {
    expect(
      paymentState(
        issued({
          receivedCents: "175000",
          creditedCents: "100000",
          outstandingCents: "0",
        }),
      ),
    ).toEqual({ label: "Paid" });
  });
  it("credited in full, nothing received", () => {
    expect(
      paymentState(
        issued({
          receivedCents: "0",
          creditedCents: "275000",
          outstandingCents: "0",
        }),
      ),
    ).toEqual({ label: "Credited in full" });
  });
  it("part credited, unpaid: owing what's left", () => {
    expect(
      paymentState(
        issued({
          receivedCents: "0",
          creditedCents: "75000",
          outstandingCents: "200000",
        }),
      ),
    ).toEqual({ label: "Unpaid", owingCents: 200000n });
  });
  it("says nothing without payment fields (no payment.read)", () => {
    expect(paymentState(issued({}))).toBeNull();
  });
  it("says nothing for drafts, void invoices and credit notes", () => {
    const fields = {
      receivedCents: "0",
      creditedCents: "0",
      outstandingCents: "275000",
    };
    for (const row of [
      { ...issued(fields), status: "draft" as const },
      { ...issued(fields), status: "void" as const },
      { ...issued(fields), kind: "credit_note" as const },
    ])
      expect(paymentState(row)).toBeNull();
  });
});
