/** Signed movements, including dated reversals; amounts stay in integer cents. */
export type DatedSettlement = {
  id: string;
  date: string;
  recordedAt: string;
  amount: bigint;
};
export function compareSettlementDates(
  a: Pick<DatedSettlement, "date" | "recordedAt" | "id">,
  b: Pick<DatedSettlement, "date" | "recordedAt" | "id">,
): number {
  return (
    a.date.localeCompare(b.date) ||
    a.recordedAt.localeCompare(b.recordedAt) ||
    a.id.localeCompare(b.id)
  );
}
/** Never mutate the ledger or assume that current balance proves past validity. */
export function settlementHistoryProblem(
  total: bigint,
  events: readonly DatedSettlement[],
) {
  let balance = 0n;
  for (const event of [...events].sort(compareSettlementDates)) {
    balance += event.amount;
    if (balance < 0n || balance > total) return { date: event.date, balance };
  }
  return null;
}
