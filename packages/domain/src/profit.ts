import { type Cents, divideRounded, sum } from "./money";

export type JobProfit = {
  /** Invoiced revenue excluding sales GST, net of credit notes. */
  revenue: Cents;
  /** Incurred cost: GST-exclusive amounts plus non-creditable GST. */
  cost: Cents;
  profit: Cents;
  /** Margin in basis points (42% = 4200), or null when revenue is zero or less. */
  marginBasisPoints: bigint | null;
};

/**
 * Management gross profit (R10). Inputs are already GST-separated, so
 * recoverable GST (sales GST, creditable purchase GST) can never reach profit.
 * Payments are not inputs: settling a balance never changes profit.
 */
export function jobProfit(input: {
  revenueExclusive: readonly Cents[];
  jobCosts: readonly Cents[];
}): JobProfit {
  const revenue = sum(input.revenueExclusive);
  const cost = sum(input.jobCosts);
  const profit = revenue - cost;
  return {
    revenue,
    cost,
    profit,
    marginBasisPoints:
      revenue > 0n ? divideRounded(profit * 10_000n, revenue) : null,
  };
}
