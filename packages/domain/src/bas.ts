import type { TaxCode } from "./gst";
import { type Cents, sum } from "./money";

export type AttributedSale = { taxCode: TaxCode; inclusive: Cents; gst: Cents };

export type DraftBasSummary = {
  /** G1 total sales (GST-inclusive). Out-of-scope amounts are excluded. */
  g1: Cents;
  /** 1A GST on sales. */
  gstOnSales: Cents;
  /** 1B GST credits on purchases. */
  gstCredits: Cents;
  /** Indicative net GST: positive is payable, negative refundable. */
  netGst: Cents;
};

/**
 * Draft GST/BAS figures for one period from amounts already attributed to it
 * (cash or non-cash). A draft for accountant review, never a lodgement; the
 * G1 inclusions are listed for accountant confirmation in domain-gst-profit.md.
 */
export function draftBasSummary(input: {
  sales: readonly AttributedSale[];
  creditableGst: readonly Cents[];
}): DraftBasSummary {
  const g1 = sum(
    input.sales
      .filter((sale) => sale.taxCode !== "OUT_OF_SCOPE")
      .map((sale) => sale.inclusive),
  );
  const gstOnSales = sum(input.sales.map((sale) => sale.gst));
  const gstCredits = sum(input.creditableGst);
  return { g1, gstOnSales, gstCredits, netGst: gstOnSales - gstCredits };
}
