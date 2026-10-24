import { describe, expect, it } from "vitest";
import {
  type InvoiceBalance,
  allocationGst,
  allocationProblems,
  jobProfit,
  receivable,
  voidAdjustmentGst,
  voidProblem,
} from "../src/index";

const invoice = (overrides: Partial<InvoiceBalance> = {}): InvoiceBalance => ({
  invoiceId: "inv-1",
  inclusive: 275_000n,
  gst: 25_000n,
  credited: 0n,
  received: 0n,
  attributed: 0n,
  ...overrides,
});
const balances = (...list: InvoiceBalance[]) =>
  new Map(list.map((balance) => [balance.invoiceId, balance]));

describe("receipts (#50)", () => {
  it("fixture: $1,000 on a $2,750 invoice leaves $1,750; profit unchanged", () => {
    const before = invoice();
    expect(
      allocationProblems(
        "receipt",
        100_000n,
        [{ invoiceId: "inv-1", amount: 100_000n }],
        balances(before),
      ),
    ).toEqual([]);
    const after = { ...before, received: 100_000n };
    expect(receivable(after)).toBe(175_000n);
    // Profit is invoiced revenue (ex GST) minus cost: receipts never enter it.
    const profit = (b: InvoiceBalance) =>
      jobProfit({
        revenueExclusive: [b.inclusive - b.gst],
        jobCosts: [145_000n],
      });
    expect(profit(after)).toEqual(profit(before));
  });

  it("rejects overpayment, a split that doesn't add up, duplicates and unknown invoices", () => {
    const b = balances(
      invoice(),
      invoice({ invoiceId: "inv-2", inclusive: 50_000n, gst: 0n }),
    );
    const fields = (
      amount: bigint,
      allocations: { invoiceId: string; amount: bigint }[],
    ) =>
      allocationProblems("receipt", amount, allocations, b).map((p) => p.field);
    expect(
      fields(300_000n, [{ invoiceId: "inv-1", amount: 300_000n }]),
    ).toEqual(["allocations.0"]);
    expect(fields(100_000n, [{ invoiceId: "inv-1", amount: 90_000n }])).toEqual(
      ["allocations"],
    );
    expect(
      fields(100_000n, [
        { invoiceId: "inv-1", amount: 50_000n },
        { invoiceId: "inv-1", amount: 50_000n },
      ]),
    ).toEqual(["allocations.1"]);
    expect(fields(100_000n, [{ invoiceId: "nope", amount: 100_000n }])).toEqual(
      ["allocations.0"],
    );
    expect(fields(0n, [])).toEqual(["amountCents", "allocations"]);
    expect(fields(10n, [{ invoiceId: "inv-1", amount: 0n }])).toEqual([
      "allocations.0",
      "allocations",
    ]);
    // Across several invoices, exactly.
    expect(
      fields(150_000n, [
        { invoiceId: "inv-1", amount: 100_000n },
        { invoiceId: "inv-2", amount: 50_000n },
      ]),
    ).toEqual([]);
  });

  it("credits reduce what's receivable; it never goes negative", () => {
    expect(receivable(invoice({ credited: 75_000n, received: 100_000n }))).toBe(
      100_000n,
    );
    expect(receivable(invoice({ credited: 275_000n, received: 10n }))).toBe(0n);
  });

  it("refunds return at most what was received", () => {
    const b = balances(invoice({ received: 100_000n }));
    expect(
      allocationProblems(
        "refund",
        100_000n,
        [{ invoiceId: "inv-1", amount: 100_000n }],
        b,
      ),
    ).toEqual([]);
    expect(
      allocationProblems(
        "refund",
        100_001n,
        [{ invoiceId: "inv-1", amount: 100_001n }],
        b,
      ).map((p) => p.message),
    ).toEqual(["That's more than was received on this invoice"]);
  });

  it("attributes cash-basis GST cumulatively; a refund reverses its share", () => {
    // $1,100 of a $2,200 invoice with $200 GST → $100 GST (docs/GST.md #6).
    const half = invoice({ inclusive: 220_000n, gst: 20_000n });
    expect(allocationGst("receipt", 110_000n, half)).toBe(10_000n);
    const rest = { ...half, received: 110_000n, attributed: 10_000n };
    expect(allocationGst("receipt", 110_000n, rest)).toBe(10_000n);
    expect(allocationGst("refund", 110_000n, rest)).toBe(-10_000n);
  });
});

describe("cash GST after voids", () => {
  // Replays the ledger: live allocations plus the adjustments voids record.
  type Entry = { kind: "receipt" | "refund"; amount: bigint; gst: bigint };
  const ledger = (inclusive: bigint, gst: bigint) => {
    const live: Entry[] = [];
    let adjustments = 0n;
    const received = () =>
      live.reduce(
        (t, e) => t + (e.kind === "receipt" ? e.amount : -e.amount),
        0n,
      );
    const attributed = () => live.reduce((t, e) => t + e.gst, adjustments);
    const balance = () =>
      invoice({
        inclusive,
        gst,
        received: received(),
        attributed: attributed(),
      });
    return {
      received,
      attributed,
      live,
      record(kind: Entry["kind"], amount: bigint) {
        const entry = {
          kind,
          amount,
          gst: allocationGst(kind, amount, balance()),
        };
        live.push(entry);
        return entry;
      },
      /** Voids it if allowed; returns the adjustment recorded, or null. */
      void(entry: Entry) {
        const now = balance();
        if (voidProblem(entry.kind, now, entry.amount)) return null;
        const adjustment = voidAdjustmentGst(entry.kind, entry, now);
        live.splice(live.indexOf(entry), 1);
        adjustments += adjustment;
        return adjustment;
      },
      /** Live GST is the rounded share of live received, after any step. */
      expected: () => (received() * gst * 2n + inclusive) / (inclusive * 2n),
    };
  };

  it("voiding a middle receipt corrects GST at once; its replacement attributes normally", () => {
    const l = ledger(11n, 1n);
    l.record("receipt", 5n);
    const middle = l.record("receipt", 1n);
    l.record("receipt", 5n);
    expect(l.live.map((e) => e.gst)).toEqual([0n, 1n, 0n]);
    // 10c stays received: round(10/11) = 1c, so the void records +1c.
    expect(l.void(middle)).toBe(1n);
    expect(l.attributed()).toBe(1n);
    expect(l.record("receipt", 1n).gst).toBe(0n);
    expect(l.attributed()).toBe(1n);
  });

  it("voiding a refund on a now fully paid invoice leaves exactly its GST (Codex #127)", () => {
    const l = ledger(11n, 1n);
    l.record("receipt", 11n);
    l.record("refund", 5n);
    const last = l.record("refund", 1n);
    l.record("receipt", 5n);
    expect(l.live.map((e) => e.gst)).toEqual([1n, 0n, -1n, 1n]);
    expect(l.void(last)).toBe(-1n);
    expect([l.received(), l.attributed()]).toEqual([11n, 1n]);
  });

  it("property: live GST is the rounded share of live received after every step", () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return BigInt(seed % n);
    };
    for (let run = 0; run < 1_000; run += 1) {
      const inclusive = next(200) + 1n;
      const l = ledger(inclusive, next(Number(inclusive) + 1));
      for (let step = 0; step < 12; step += 1) {
        const room = inclusive - l.received();
        const choice = next(3);
        if (choice === 0n && room > 0n)
          l.record("receipt", next(Number(room)) + 1n);
        else if (choice === 1n && l.received() > 0n)
          l.record("refund", next(Number(l.received())) + 1n);
        else if (l.live.length > 0)
          l.void(l.live[Number(next(l.live.length))]!);
        expect(l.attributed()).toBe(l.expected());
      }
    }
  });
});

describe("voiding receipts and refunds", () => {
  it("a receipt void can't leave refunds returning money never received", () => {
    const paid = invoice({ received: 60_000n });
    expect(voidProblem("receipt", paid, 60_000n)).toBeNull();
    expect(voidProblem("receipt", paid, 100_000n)).toMatch(
      /void the refund first/,
    );
  });

  it("a refund void can't overpay once a replacement receipt used the capacity", () => {
    // $100 invoice: receipt 100, refund 100, replacement receipt 100.
    const replaced = invoice({ inclusive: 10_000n, received: 10_000n });
    expect(voidProblem("refund", replaced, 10_000n)).toMatch(/overpay/);
    // Credits reduce what's due, so they count too.
    const credited = invoice({
      inclusive: 10_000n,
      credited: 4_000n,
      received: 2_000n,
    });
    expect(voidProblem("refund", credited, 4_000n)).toBeNull();
    expect(voidProblem("refund", credited, 4_001n)).toMatch(/overpay/);
  });
});
