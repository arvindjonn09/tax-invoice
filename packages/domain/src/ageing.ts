import { isIsoDate } from "./registration";
import { type Cents, sum } from "./money";

// Debtor/creditor ageing and cash movement (#56). Ageing is what was still
// owed at the end of an as-at day, as the records stood that day: later
// settlements, credits and voids don't rewrite an earlier ageing. Cash
// movement is money in less money out; it is never profit.

/** One dated change to what is owed: a receipt, refund, payment or credit. */
export type AgeingSettlement = {
  /** Business day it took effect. */
  on: string;
  /** Reduces what is owed; a refund of a receipt is negative. */
  amount: Cents;
  /** Business day it was voided, if ever. */
  voidedOn: string | null;
};

export type AgeingDocument = {
  id: string;
  partyId: string | null;
  issuedOn: string;
  /** No due date: due on issue. */
  dueOn: string | null;
  /** GST-inclusive total owed when issued. */
  inclusive: Cents;
  voidedOn: string | null;
  settlements: readonly AgeingSettlement[];
};

export const AGEING_BUCKETS = [
  "current",
  "days1To30",
  "days31To60",
  "days61To90",
  "days91Plus",
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];
export type AgeingTotals = Record<AgeingBucket, Cents> & { total: Cents };

const DAY_MS = 86_400_000;
/** Whole days from `from` to `to` (both ISO dates). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

export function ageingBucket(daysOverdue: number): AgeingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "days1To30";
  if (daysOverdue <= 60) return "days31To60";
  if (daysOverdue <= 90) return "days61To90";
  return "days91Plus";
}

const live = (voidedOn: string | null, asAt: string) =>
  voidedOn === null || voidedOn > asAt;

/** What was still owed on `doc` at the end of `asAt` (never negative). */
export function owedAsAt(doc: AgeingDocument, asAt: string): Cents {
  if (doc.issuedOn > asAt || !live(doc.voidedOn, asAt)) return 0n;
  const settled = sum(
    doc.settlements
      .filter((s) => s.on <= asAt && live(s.voidedOn, asAt))
      .map((s) => s.amount),
  );
  const owed = doc.inclusive - settled;
  return owed < 0n ? 0n : owed;
}

const zero = (): AgeingTotals => ({
  current: 0n,
  days1To30: 0n,
  days31To60: 0n,
  days61To90: 0n,
  days91Plus: 0n,
  total: 0n,
});

export type AgeingRow = {
  id: string;
  partyId: string | null;
  issuedOn: string;
  dueOn: string;
  daysOverdue: number;
  bucket: AgeingBucket;
  inclusive: Cents;
  owed: Cents;
};

/**
 * Age every document with something owed at the end of `asAt`. Rows are
 * oldest due first; totals and party totals always cover every row.
 */
export function ageingReport(
  documents: readonly AgeingDocument[],
  asAt: string,
) {
  if (!isIsoDate(asAt)) throw new RangeError("Choose a valid as-at date");
  const rows: AgeingRow[] = [];
  for (const doc of documents) {
    const owed = owedAsAt(doc, asAt);
    if (owed === 0n) continue;
    const dueOn = doc.dueOn ?? doc.issuedOn;
    const daysOverdue = Math.max(0, daysBetween(dueOn, asAt));
    rows.push({
      id: doc.id,
      partyId: doc.partyId,
      issuedOn: doc.issuedOn,
      dueOn,
      daysOverdue,
      bucket: ageingBucket(daysOverdue),
      inclusive: doc.inclusive,
      owed,
    });
  }
  rows.sort(
    (a, b) =>
      a.dueOn.localeCompare(b.dueOn) ||
      a.issuedOn.localeCompare(b.issuedOn) ||
      a.id.localeCompare(b.id),
  );
  const totals = zero();
  const parties = new Map<string | null, AgeingTotals>();
  for (const row of rows) {
    const party = parties.get(row.partyId) ?? zero();
    for (const t of [totals, party]) {
      t[row.bucket] += row.owed;
      t.total += row.owed;
    }
    parties.set(row.partyId, party);
  }
  return {
    asAt,
    totals,
    parties: [...parties]
      .map(([partyId, t]) => ({ partyId, ...t }))
      .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0)),
    rows,
  };
}

export type CashMovement = {
  id: string;
  date: string;
  direction: "in" | "out";
  /** Signed: a refund received back is negative money in. */
  amount: Cents;
};

/** Money in less money out, by month. Labelled: this is not profit. */
export function cashMovementReport(
  movements: readonly CashMovement[],
  range: { from: string; to: string },
) {
  if (!isIsoDate(range.from) || !isIsoDate(range.to) || range.from > range.to)
    throw new RangeError("Choose a valid inclusive date range");
  const selected = movements.filter(
    (m) => m.date >= range.from && m.date <= range.to,
  );
  const months = new Map<string, { in: Cents; out: Cents }>();
  for (const m of selected) {
    const month = m.date.slice(0, 7);
    const row = months.get(month) ?? { in: 0n, out: 0n };
    row[m.direction] += m.amount;
    months.set(month, row);
  }
  const moneyIn = sum(
    selected.filter((m) => m.direction === "in").map((m) => m.amount),
  );
  const moneyOut = sum(
    selected.filter((m) => m.direction === "out").map((m) => m.amount),
  );
  return {
    label: "Cash movement — money in less money out, not profit" as const,
    moneyIn,
    moneyOut,
    net: moneyIn - moneyOut,
    months: [...months]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, row]) => ({
        month,
        moneyIn: row.in,
        moneyOut: row.out,
        net: row.in - row.out,
      })),
  };
}
