"use client";
import { formatAudCents } from "@/components/money-display";
import { parseAudInput } from "@/lib/aud-input";

export type Target = {
  id: string;
  label: string;
  detail: string;
  /** The most this settlement can allocate to it (outstanding, or received for a refund). */
  limitCents: string;
  limitLabel: string;
};

export type Allocation = { selected: boolean; amount: string };

/** Entered cents, or null when blank/invalid. */
export function allocationCents(text: string): bigint | null {
  try {
    const value = parseAudInput(text);
    return value === null ? null : BigInt(value);
  } catch {
    return null;
  }
}

/** Sum of selected, valid allocations; null if any selected amount is invalid. */
export function allocationTotal(
  targets: readonly Target[],
  state: Record<string, Allocation>,
): bigint | null {
  let total = 0n;
  for (const target of targets) {
    const row = state[target.id];
    if (!row?.selected) continue;
    const cents = allocationCents(row.amount);
    if (cents === null || cents <= 0n) return null;
    total += cents;
  }
  return total;
}

/**
 * One row per bill or invoice: tick it and enter how much of this payment
 * settles it. The limit (what's still owing) is shown next to each.
 */
export function AllocationTable({
  legend,
  targets,
  state,
  errors,
  onChange,
}: {
  legend: string;
  targets: readonly Target[];
  state: Record<string, Allocation>;
  /** Keyed by bill or invoice id. */
  errors: Record<string, string>;
  onChange: (id: string, next: Allocation) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 font-semibold">{legend}</legend>
      <ul className="space-y-3">
        {targets.map((target) => {
          const row = state[target.id] ?? { selected: false, amount: "" };
          const error = errors[target.id];
          const amountId = `allocation-${target.id}`;
          return (
            <li
              key={target.id}
              className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[2fr_1fr] sm:items-end"
            >
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-5"
                  checked={row.selected}
                  onChange={(event) =>
                    onChange(target.id, {
                      selected: event.target.checked,
                      amount:
                        event.target.checked && !row.amount
                          ? `${BigInt(target.limitCents) / 100n}.${(BigInt(target.limitCents) % 100n).toString().padStart(2, "0")}`
                          : row.amount,
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block font-semibold [overflow-wrap:anywhere]">
                    {target.label}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {target.detail} · {target.limitLabel}{" "}
                    <span className="tabular-nums">
                      {formatAudCents(BigInt(target.limitCents))} AUD
                    </span>
                  </span>
                </span>
              </label>
              <div className="flex min-w-0 flex-col gap-2">
                <label htmlFor={amountId} className="font-medium">
                  Amount for {target.label}
                </label>
                <input
                  id={amountId}
                  inputMode="decimal"
                  disabled={!row.selected}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `${amountId}-error` : undefined}
                  className="min-h-11 w-full min-w-0 rounded-sm border border-input bg-card px-4 text-card-foreground disabled:opacity-60 aria-[invalid=true]:border-danger-foreground"
                  value={row.amount}
                  onChange={(event) =>
                    onChange(target.id, { ...row, amount: event.target.value })
                  }
                />
                {error ? (
                  <p
                    id={`${amountId}-error`}
                    className="text-sm text-danger-foreground"
                  >
                    {error}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * The selected allocations as sent, plus a mapper from the server's
 * "allocations.<n>" error keys back to bill or invoice ids.
 */
export function chosen(
  targets: readonly Target[],
  state: Record<string, Allocation>,
) {
  const picked = targets.filter((target) => state[target.id]?.selected);
  return {
    ids: picked.map((target) => target.id),
    amounts: picked.map(
      (target) => allocationCents(state[target.id]!.amount) ?? 0n,
    ),
    remap(fields: Record<string, string>) {
      const byTarget: Record<string, string> = {};
      const rest: Record<string, string> = {};
      for (const [key, text] of Object.entries(fields)) {
        const match = /^allocations\.(\d+)/.exec(key);
        const id = match ? picked[Number(match[1])]?.id : undefined;
        if (id) byTarget[id] = text;
        else rest[key] = text;
      }
      return { byTarget, rest };
    },
  };
}
