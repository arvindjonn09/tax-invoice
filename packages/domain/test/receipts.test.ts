import { describe, expect, it } from "vitest";
import {
  type InvoiceBalance,
  allocationGst,
  allocationProblems,
  jobProfit,
  receivable,
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
  // Invoice $0.11 with $0.01 GST, replaying allocations as the ledger does:
  // each new allocation sees the live (unvoided) received and attributed.
  type Entry = { kind: "receipt" | "refund"; amount: bigint; gst: bigint };
  const tiny = { inclusive: 11n, gst: 1n };
  const record = (live: Entry[], kind: Entry["kind"], amount: bigint) => {
    const received = live.reduce(
      (t, e) => t + (e.kind === "receipt" ? e.amount : -e.amount),
      0n,
    );
    const attributed = live.reduce((t, e) => t + e.gst, 0n);
    const entry = {
      kind,
      amount,
      gst: allocationGst(
        kind,
        amount,
        invoice({ ...tiny, received, attributed }),
      ),
    };
    live.push(entry);
    return entry;
  };
  const liveGst = (live: Entry[]) => live.reduce((t, e) => t + e.gst, 0n);

  it("a replacement for a voided middle receipt recovers its rounding cent", () => {
    const live: Entry[] = [];
    record(live, "receipt", 5n);
    const middle = record(live, "receipt", 1n);
    record(live, "receipt", 5n);
    expect(live.map((e) => e.gst)).toEqual([0n, 1n, 0n]);
    live.splice(live.indexOf(middle), 1); // void, history unchanged
    expect(liveGst(live)).toBe(0n);
    expect(record(live, "receipt", 1n).gst).toBe(1n);
    expect(liveGst(live)).toBe(tiny.gst);
  });

  it("re-receiving after a refund void ends at exactly the invoice's GST", () => {
    const live: Entry[] = [];
    record(live, "receipt", 11n);
    const first = record(live, "refund", 5n);
    record(live, "refund", 1n);
    expect(live.map((e) => e.gst)).toEqual([1n, 0n, -1n]);
    live.splice(live.indexOf(first), 1);
    expect(record(live, "receipt", 1n).gst).toBe(1n);
    expect(liveGst(live)).toBe(tiny.gst);
  });

  it("property: after any voids, settling in full attributes exactly the GST", () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return BigInt(seed % n);
    };
    for (let run = 0; run < 300; run += 1) {
      const inclusive = next(10_000) + 1n;
      const gst = next(Number(inclusive) + 1);
      const shape = { inclusive, gst };
      let live: Entry[] = [];
      const net = () =>
        live.reduce(
          (t, e) => t + (e.kind === "receipt" ? e.amount : -e.amount),
          0n,
        );
      const add = (kind: Entry["kind"], amount: bigint) => {
        const attributed = live.reduce((t, e) => t + e.gst, 0n);
        const balance = invoice({ ...shape, received: net(), attributed });
        live.push({ kind, amount, gst: allocationGst(kind, amount, balance) });
      };
      for (let step = 0; step < 8; step += 1) {
        const room = inclusive - net();
        const choice = next(3);
        if (choice === 0n && room > 0n) add("receipt", next(Number(room)) + 1n);
        else if (choice === 1n && net() > 0n)
          add("refund", next(Number(net())) + 1n);
        else if (live.length > 0) {
          // Void one entry if the ledger stays within 0…total.
          const index = Number(next(live.length));
          const rest = live.filter((_, i) => i !== index);
          const restNet = rest.reduce(
            (t, e) => t + (e.kind === "receipt" ? e.amount : -e.amount),
            0n,
          );
          if (restNet >= 0n && restNet <= inclusive) live = rest;
        }
      }
      if (net() < inclusive) add("receipt", inclusive - net());
      expect(live.reduce((t, e) => t + e.gst, 0n)).toBe(gst);
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
