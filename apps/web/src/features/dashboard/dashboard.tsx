"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { DashboardData } from "@/server/dashboard/handlers";
import { useRemote } from "@/components/data/use-remote";
import { PageHeader } from "@/components/shell/page-header";
import { Field } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { MoneyDisplay, formatAudCents } from "@/components/money-display";

const CARD = "min-w-0 rounded-lg border bg-card p-5";
const LINK =
  "inline-flex min-h-11 items-center font-semibold underline [overflow-wrap:anywhere]";
const amount = (cents: string, basis: "ex GST" | "incl GST" = "ex GST") => (
  <MoneyDisplay cents={BigInt(cents)} basis={basis} />
);
const tax = (cents: string) => (
  <span className="money">{formatAudCents(BigInt(cents))} AUD GST</span>
);
function Figure({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className={CARD}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-xl font-semibold [overflow-wrap:anywhere]">
        {children}
      </dd>
      {note ? (
        <dd className="mt-2 text-sm text-muted-foreground">{note}</dd>
      ) : null}
    </div>
  );
}
const percent = (bp: string | null) => {
  if (bp === null) return "No revenue yet";
  const value = BigInt(bp),
    abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}% margin`;
};

export function Dashboard({ today }: { today: string }) {
  const month = Number(today.slice(5, 7));
  const initial = {
    from: `${today.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`,
    to: today,
    customerId: "",
    jobId: "",
  };
  const [range, setRange] = useState(initial),
    [draft, setDraft] = useState(initial);
  const query = new URLSearchParams({
    from: range.from,
    to: range.to,
    ...(range.customerId ? { customerId: range.customerId } : {}),
    ...(range.jobId ? { jobId: range.jobId } : {}),
  });
  const { data, error, reload } = useRemote<DashboardData>(
    `/api/dashboard?${query}`,
  );
  const [options, setOptions] = useState<Pick<
    DashboardData,
    "customers" | "jobs"
  > | null>(null);
  if (data && options?.jobs !== data.jobs)
    setOptions({ customers: data.customers, jobs: data.jobs });
  const invalid =
    !draft.from || !draft.to
      ? "Choose both dates"
      : draft.from > draft.to
        ? "End date must be on or after start date"
        : undefined;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Profit, cash and what's owing, from your recorded work."
      />
      <form
        className={`${CARD} grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-5`}
        aria-label="Dashboard filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) setRange(draft);
        }}
      >
        <Field id="dashboard-from" label="From">
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          )}
        </Field>
        <Field id="dashboard-to" label="To" error={invalid}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          )}
        </Field>
        <Field id="dashboard-customer" label="Customer">
          {(control) => (
            <select
              {...control}
              value={draft.customerId}
              onChange={(e) =>
                setDraft({ ...draft, customerId: e.target.value, jobId: "" })
              }
            >
              <option value="">All customers</option>
              {options?.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="dashboard-job" label="Job">
          {(control) => (
            <select
              {...control}
              value={draft.jobId}
              onChange={(e) => setDraft({ ...draft, jobId: e.target.value })}
            >
              <option value="">All jobs</option>
              {options?.jobs
                .filter(
                  (j) => !draft.customerId || j.customerId === draft.customerId,
                )
                .map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.reference} · {j.title}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Button type="submit" disabled={Boolean(invalid)}>
          Show dashboard
        </Button>
      </form>
      {error ? (
        <section role="alert" className={CARD}>
          <p>{error}</p>
          <Button onClick={reload}>Try again</Button>
        </section>
      ) : !data ? (
        <p role="status">Loading dashboard…</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Activity from {data.range.from} to {data.range.to}. Costs include
            non-creditable GST; recoverable GST is excluded from profit.
          </p>
          {data.warnings.length ? (
            <section
              role="alert"
              className={`${CARD} border-danger-foreground`}
            >
              <h2 className="font-semibold">Records to review</h2>
              <ul className="list-disc pl-5">
                {data.warnings.map((w) => (
                  <li key={w.sourceId}>{w.message}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <dl
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Profit in this range"
          >
            <Figure label="Invoiced revenue">
              {amount(data.totals.revenue)}
            </Figure>
            <Figure label="Incurred job costs">
              {amount(data.totals.cost)}
            </Figure>
            <Figure
              label="Gross profit"
              note={percent(data.totals.marginBasisPoints)}
            >
              {amount(data.totals.profit)}
            </Figure>
            <Figure label="Received" note="Cash received — not profit">
              {amount(data.totals.receivedInclusive, "incl GST")}
            </Figure>
            <Figure label="Paid" note="Cash paid — not an additional cost">
              {amount(data.totals.paidInclusive, "incl GST")}
            </Figure>
          </dl>
          {data.ledger ? (
            <section className="space-y-3" aria-labelledby="dashboard-balances">
              <h2 id="dashboard-balances" className="text-xl font-semibold">
                What&apos;s owing at {data.ledger.asAt}
              </h2>
              <p className="text-sm text-muted-foreground">
                Balances include earlier outstanding records and follow the
                customer and job filters.
              </p>
              <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Figure label="Customers owe">
                  {amount(data.ledger.receivables.total, "incl GST")}
                </Figure>
                <Figure label="Customer overdue">
                  {amount(data.ledger.receivables.overdue, "incl GST")}
                </Figure>
                <Figure label="Supplier bills owing">
                  {amount(data.ledger.payables.total, "incl GST")}
                </Figure>
                <Figure label="Supplier bills overdue">
                  {amount(data.ledger.payables.overdue, "incl GST")}
                </Figure>
              </dl>
              <div className={`${CARD} space-y-3`}>
                <h3 className="font-semibold">Overdue customer invoices</h3>
                {data.ledger.receivables.documents.length ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Showing the oldest{" "}
                      {data.ledger.receivables.documents.length} of{" "}
                      {data.ledger.receivables.overdueCount} overdue invoices.
                    </p>
                    <ul className="divide-y">
                      {data.ledger.receivables.documents.map((row) => (
                        <li
                          key={row.id}
                          className="flex flex-wrap items-center justify-between gap-3 py-2"
                        >
                          <Link className={LINK} href={`/invoices/${row.id}`}>
                            {row.reference} · {row.partyName}
                          </Link>
                          <span>
                            {amount(row.owed, "incl GST")} · {row.daysOverdue}{" "}
                            days overdue
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>No overdue customer invoices for these filters.</p>
                )}
                <Link className={LINK} href="/invoices">
                  Open invoices
                </Link>
              </div>
            </section>
          ) : null}
          {data.gst ? (
            <section className="space-y-3" aria-labelledby="dashboard-gst">
              <h2 id="dashboard-gst" className="text-xl font-semibold">
                Draft BAS/GST summary — not lodged
              </h2>
              {data.gst.revision ? (
                <p>Finalised period · revision {data.gst.revision}</p>
              ) : null}
              {data.gst.incomplete ? (
                <p role="alert" className={`${CARD} border-danger-foreground`}>
                  Some cash-basis GST is left out until the records above are
                  reviewed. Do not use these figures for a BAS.
                </p>
              ) : null}
              {range.jobId || range.customerId ? (
                <p>
                  Filtered GST composition; this is not the whole company&apos;s
                  BAS.
                </p>
              ) : null}
              <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Figure label="G1 Total sales">
                  {amount(data.gst.g1, "incl GST")}
                </Figure>
                <Figure label="1A GST on sales">{tax(data.gst.oneA)}</Figure>
                <Figure label="1B GST credits">{tax(data.gst.oneB)}</Figure>
                <Figure label="Net GST payable / refund">
                  {tax(data.gst.netGst)}
                </Figure>
              </dl>
            </section>
          ) : null}
          <section className="space-y-3" aria-labelledby="dashboard-jobs">
            <h2 id="dashboard-jobs" className="text-xl font-semibold">
              Recently updated jobs
            </h2>
            <p className="text-sm text-muted-foreground">
              Current job status for the selected customer and job.
            </p>
            {data.recentJobs.length ? (
              <ul className="grid gap-3 sm:grid-cols-2">
                {data.recentJobs.map((j) => (
                  <li key={j.id} className={CARD}>
                    <Link className={LINK} href={`/jobs/${j.id}`}>
                      {j.reference} · {j.title}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {j.status.replaceAll("_", " ")} · updated {j.updatedOn}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No jobs match these filters.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
