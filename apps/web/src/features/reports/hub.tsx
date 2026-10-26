"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Field } from "@/components/form/field";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  MoneyDisplay,
  formatAudCents,
  type MoneyBasis,
} from "@/components/money-display";
import { useRemote } from "@/components/data/use-remote";

// Report screens (#58). Every figure here is authoritative cents from the
// server, formatted for display only; nothing is computed in the browser.
// CSV exports link to the server, which produces machine-readable cents.

export type ReportView = "profitability" | "gst" | "ageing" | "cash";
const VIEW_LABEL: Record<ReportView, string> = {
  profitability: "Job profit",
  gst: "Draft GST",
  ageing: "Who owes what",
  cash: "Cash movement",
};

type Source = { type: string; reference: string; party: string };
type Event = {
  id: string;
  sourceId: string;
  date: string;
  jobId: string | null;
  channel: string;
  amount: string;
  salesInclusive?: string;
};
type EventsPage = { page: number; pageSize: number; total: number };
type Totals = {
  revenue: string;
  cost: string;
  profit: string;
  marginBasisPoints: string | null;
  receivedInclusive: string;
  paidInclusive: string;
};
type Warning = { sourceId: string; message: string };
type Profitability = {
  totals: Totals;
  jobs: (Totals & { jobId: string })[];
  positions: {
    jobId: string;
    reference: string;
    title: string;
    committedCost: string;
  }[];
  committedCost: string;
  events: Event[];
  eventsPage: EventsPage;
  eventSources: Record<string, Source>;
  warnings: Warning[];
};
type Gst = {
  label: string;
  g1: string;
  oneA: string;
  oneB: string;
  netGst: string;
  events: Event[];
  eventsPage: EventsPage;
  eventSources: Record<string, Source>;
  warnings?: Warning[];
  incomplete?: boolean;
  finalization?: { revision: number; lockedAt: string | null };
};
type AgeingRow = {
  id: string;
  reference: string;
  partyName: string;
  issuedOn: string;
  dueOn: string;
  daysOverdue: number;
  bucket: Bucket;
  owed: string;
};
type Bucket =
  "current" | "days1To30" | "days31To60" | "days61To90" | "days91Plus";
type AgeingTotals = Record<Bucket, string> & { total: string };
type Ageing = {
  totals: AgeingTotals;
  parties: (AgeingTotals & { partyId: string | null; partyName: string })[];
  rows: AgeingRow[];
  rowsPage: EventsPage;
};
type Cash = {
  label: string;
  moneyIn: string;
  moneyOut: string;
  net: string;
  months: { month: string; moneyIn: string; moneyOut: string; net: string }[];
};

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "current", label: "Not yet due" },
  { key: "days1To30", label: "1–30 days overdue" },
  { key: "days31To60", label: "31–60 days" },
  { key: "days61To90", label: "61–90 days" },
  { key: "days91Plus", label: "Over 90 days" },
];
const CHANNEL: Record<string, string> = {
  invoiced: "Invoiced (ex GST)",
  incurred: "Job cost",
  received: "Received (incl GST)",
  paid: "Paid (incl GST)",
  gst_sales: "1A GST on sales",
  gst_purchases: "1B GST credits",
};
const BASIS: Record<string, MoneyBasis> = {
  invoiced: "ex GST",
  incurred: "ex GST",
  received: "incl GST",
  paid: "incl GST",
};
const SOURCE_TYPE: Record<string, string> = {
  invoice: "Invoice",
  credit_note: "Credit note",
  supplier_bill: "Supplier bill",
  supplier_credit: "Supplier credit",
  expense: "Expense",
  gst_adjustment: "GST adjustment",
  timesheet: "Labour",
};
const sourceHref = (id: string, source?: Source) =>
  source?.type === "invoice" || source?.type === "credit_note"
    ? `/invoices/${id}`
    : source?.type === "supplier_bill"
      ? `/payments/bills/${id}`
      : source?.type === "expense"
        ? `/expenses/${id}`
        : null;

const LINK =
  "inline-flex min-h-11 max-w-full items-center font-semibold underline [overflow-wrap:anywhere]";
const CARD = "rounded-lg border bg-card p-4";
const money = (cents: string, basis: MoneyBasis) => (
  <MoneyDisplay cents={BigInt(cents)} basis={basis} />
);
/** A GST amount itself: neither ex nor incl GST. */
const gstMoney = (cents: string) => (
  <span className="money">{formatAudCents(BigInt(cents))} AUD GST</span>
);
/** Basis points as a percentage, exactly (no floating point). */
const percent = (basisPoints: string) => {
  const bp = BigInt(basisPoints),
    abs = bp < 0n ? -bp : bp;
  return `${bp < 0n ? "−" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`;
};
const day = (iso: string) =>
  new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));

/** BAS quarters (Jul–Sep, …) and financial years, from a Sydney date. */
export function presets(today: string) {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const q = Math.floor((m - 1) / 3);
  const quarter = (year: number, index: number) => {
    const start = `${year}-${String(index * 3 + 1).padStart(2, "0")}-01`;
    const end = new Date(Date.UTC(year, index * 3 + 3, 0))
      .toISOString()
      .slice(0, 10);
    return { from: start, to: end };
  };
  const fy = m >= 7 ? y : y - 1;
  return [
    { label: "This quarter", ...quarter(y, q) },
    {
      label: "Last quarter",
      ...(q === 0 ? quarter(y - 1, 3) : quarter(y, q - 1)),
    },
    {
      label: "This financial year",
      from: `${fy}-07-01`,
      to: `${fy + 1}-06-30`,
    },
    {
      label: "Last financial year",
      from: `${fy - 1}-07-01`,
      to: `${fy}-06-30`,
    },
  ];
}

function Failure({ error, reload }: { error: string; reload: () => void }) {
  return (
    <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
      <p>{error}</p>
      <Button onClick={reload}>Try again</Button>
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <section className="space-y-2 rounded-lg border bg-card p-8">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-muted-foreground">{text}</p>
    </section>
  );
}
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
    <div className={`${CARD} min-w-0 space-y-1`}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold [overflow-wrap:anywhere]">
        {children}
      </dd>
      {note ? <dd className="text-sm text-muted-foreground">{note}</dd> : null}
    </div>
  );
}
function Paging({
  page,
  label,
  onPage,
}: {
  page: EventsPage;
  label: string;
  onPage: (page: number) => void;
}) {
  if (page.total <= page.pageSize) return null;
  const last = Math.ceil(page.total / page.pageSize);
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        disabled={page.page <= 1}
        onClick={() => onPage(page.page - 1)}
      >
        Previous
      </Button>
      <span>
        Page {page.page} of {last}
      </span>
      <Button
        variant="outline"
        disabled={page.page >= last}
        onClick={() => onPage(page.page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}
function ExportLink({ href, children }: { href: string; children: string }) {
  return (
    <a className={buttonVariants({ variant: "outline" })} href={href} download>
      {children}
    </a>
  );
}
function Warnings({ warnings }: { warnings?: Warning[] | undefined }) {
  if (!warnings?.length) return null;
  return (
    <section
      role="alert"
      className="space-y-2 rounded-lg border border-danger-foreground bg-card p-4"
    >
      <h2 className="font-semibold">Records to review</h2>
      <ul className="list-disc space-y-1 pl-6">
        {warnings.map((w) => (
          <li key={w.sourceId}>{w.message}</li>
        ))}
      </ul>
    </section>
  );
}

/** One drill-down line: the source document, its date and its amount. */
function Events({
  events,
  sources,
  page,
  onPage,
  label,
}: {
  events: Event[];
  sources: Record<string, Source>;
  page: EventsPage;
  onPage: (page: number) => void;
  label: string;
}) {
  if (!events.length)
    return <p className="text-muted-foreground">Nothing in this range.</p>;
  return (
    <>
      <ul className="space-y-2" aria-label={label}>
        {events.map((event) => {
          const source = sources[event.sourceId];
          const href = sourceHref(event.sourceId, source);
          const name = source
            ? `${SOURCE_TYPE[source.type] ?? source.type}${source.reference ? ` ${source.reference}` : ""}`
            : "Source record";
          return (
            <li
              key={event.id}
              className={`${CARD} grid gap-1 sm:grid-cols-[8rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center`}
            >
              <span>{day(event.date)}</span>
              <span className="min-w-0">
                {href ? (
                  <Link className={LINK} href={href}>
                    {name}
                  </Link>
                ) : (
                  <span className="font-semibold [overflow-wrap:anywhere]">
                    {name}
                  </span>
                )}
                {source?.party ? (
                  <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {source.party}
                  </span>
                ) : null}
              </span>
              <span className="text-sm">
                {CHANNEL[event.channel] ?? event.channel}
              </span>
              <span className="sm:text-right">
                {BASIS[event.channel]
                  ? money(event.amount, BASIS[event.channel]!)
                  : gstMoney(event.amount)}
              </span>
            </li>
          );
        })}
      </ul>
      <Paging page={page} label={`${label} pages`} onPage={onPage} />
    </>
  );
}

function RangeFilter({
  today,
  range,
  onChange,
}: {
  today: string;
  range: { from: string; to: string };
  onChange: (range: { from: string; to: string }) => void;
}) {
  const [draft, setDraft] = useState(range);
  const invalid =
    !draft.from || !draft.to
      ? "Choose both dates"
      : draft.from > draft.to
        ? "End date must be on or after start date"
        : undefined;
  return (
    <form
      className={`${CARD} space-y-4`}
      aria-label="Date range"
      onSubmit={(event) => {
        event.preventDefault();
        if (!invalid) onChange(draft);
      }}
    >
      <div className="flex flex-wrap gap-2">
        {presets(today).map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant={
              preset.from === range.from && preset.to === range.to
                ? "default"
                : "outline"
            }
            aria-pressed={preset.from === range.from && preset.to === range.to}
            onClick={() => {
              setDraft(preset);
              onChange(preset);
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]">
        <Field id="report-from" label="From">
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          )}
        </Field>
        <Field id="report-to" label="To" error={invalid}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          )}
        </Field>
        <Button type="submit" disabled={Boolean(invalid)}>
          Show
        </Button>
      </div>
    </form>
  );
}

function ProfitView({
  range,
  canExport,
}: {
  range: { from: string; to: string };
  canExport: boolean;
}) {
  const [jobId, setJobId] = useState("");
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({
    ...range,
    ...(jobId ? { jobId } : {}),
    eventsPage: String(page),
    eventsPageSize: "50",
  });
  const { data, error, reload } = useRemote<Profitability>(
    `/api/reports/profitability?${query}`,
  );
  if (error) return <Failure error={error} reload={reload} />;
  if (!data) return <p role="status">Loading job profit…</p>;
  const t = data.totals;
  const margin =
    t.marginBasisPoints === null
      ? "No revenue yet"
      : percent(t.marginBasisPoints);
  return (
    <div className="space-y-6">
      <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field id="report-job" label="Job">
          {(control) => (
            <select
              {...control}
              value={jobId}
              onChange={(e) => {
                setJobId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All jobs</option>
              {data.positions.map((p) => (
                <option key={p.jobId} value={p.jobId}>
                  {p.reference} · {p.title}
                </option>
              ))}
            </select>
          )}
        </Field>
        {canExport ? (
          <ExportLink
            href={`/api/exports/profitability?${new URLSearchParams(range)}`}
          >
            Export CSV
          </ExportLink>
        ) : null}
      </div>
      <Warnings warnings={data.warnings} />
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Revenue">{money(t.revenue, "ex GST")}</Figure>
        <Figure label="Job costs">{money(t.cost, "ex GST")}</Figure>
        <Figure label="Gross profit" note={`Margin ${margin}`}>
          {money(t.profit, "ex GST")}
        </Figure>
        <Figure
          label="Committed, not yet billed"
          note="Accepted subcontract work still to be billed"
        >
          {money(data.committedCost, "ex GST")}
        </Figure>
      </dl>
      <section className={`${CARD} space-y-2`} aria-labelledby="cash-note">
        <h2 id="cash-note" className="font-semibold">
          Cash in this range — not profit
        </h2>
        <p>
          Received {money(t.receivedInclusive, "incl GST")} · Paid{" "}
          {money(t.paidInclusive, "incl GST")}
        </p>
      </section>
      {data.jobs.length ? (
        <section className="space-y-3" aria-labelledby="jobs-heading">
          <h2 id="jobs-heading" className="text-xl font-semibold">
            By job
          </h2>
          <ul className="space-y-2">
            {data.jobs.map((job) => {
              const p = data.positions.find((x) => x.jobId === job.jobId);
              return (
                <li
                  key={job.jobId}
                  className={`${CARD} grid gap-1 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] sm:items-center`}
                >
                  <Link className={LINK} href={`/jobs/${job.jobId}`}>
                    {p ? `${p.reference} · ${p.title}` : "Job"}
                  </Link>
                  <span>Revenue {money(job.revenue, "ex GST")}</span>
                  <span>Cost {money(job.cost, "ex GST")}</span>
                  <span className="font-semibold">
                    Profit {money(job.profit, "ex GST")}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <section className="space-y-3" aria-labelledby="profit-events">
        <h2 id="profit-events" className="text-xl font-semibold">
          What makes up these figures
        </h2>
        <Events
          events={data.events}
          sources={data.eventSources}
          page={data.eventsPage}
          onPage={setPage}
          label="Profit records"
        />
      </section>
    </div>
  );
}

function GstView({
  range,
  canExport,
}: {
  range: { from: string; to: string };
  canExport: boolean;
}) {
  const [page, setPage] = useState(1);
  const { data, error, reload } = useRemote<Gst>(
    `/api/reports/gst?${new URLSearchParams({ ...range, eventsPage: String(page), eventsPageSize: "50" })}`,
  );
  if (error) return <Failure error={error} reload={reload} />;
  if (!data) return <p role="status">Loading the draft GST summary…</p>;
  const exportQuery = new URLSearchParams(range);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold">
          {data.finalization
            ? `Finalised period · revision ${data.finalization.revision}`
            : "Draft BAS/GST summary — not lodged"}
        </p>
        {canExport ? (
          <div className="flex flex-wrap gap-2">
            <ExportLink href={`/api/exports/gst-summary?${exportQuery}`}>
              Export summary CSV
            </ExportLink>
            <ExportLink href={`/api/exports/gst-lines?${exportQuery}`}>
              Export GST lines CSV
            </ExportLink>
          </div>
        ) : null}
      </div>
      {data.incomplete ? (
        <p role="alert" className={`${CARD} border-danger-foreground`}>
          Some cash-basis GST is left out until the records below are reviewed.
          Don&apos;t use these figures for a BAS yet.
        </p>
      ) : null}
      <Warnings warnings={data.warnings} />
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="G1 Total sales">{money(data.g1, "incl GST")}</Figure>
        <Figure label="1A GST on sales">{gstMoney(data.oneA)}</Figure>
        <Figure label="1B GST credits">{gstMoney(data.oneB)}</Figure>
        <Figure
          label={
            BigInt(data.netGst) < 0n ? "Net GST refund" : "Net GST payable"
          }
        >
          {gstMoney(data.netGst)}
        </Figure>
      </dl>
      <section className="space-y-3" aria-labelledby="gst-events">
        <h2 id="gst-events" className="text-xl font-semibold">
          GST composition
        </h2>
        <Events
          events={data.events}
          sources={data.eventSources}
          page={data.eventsPage}
          onPage={setPage}
          label="GST records"
        />
      </section>
    </div>
  );
}

function AgeingView({
  today,
  canExport,
}: {
  today: string;
  canExport: boolean;
}) {
  const [side, setSide] = useState<"receivables" | "payables">("receivables");
  const [asAt, setAsAt] = useState(today);
  const [page, setPage] = useState(1);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(asAt);
  const query = new URLSearchParams({
    side,
    asAt,
    page: String(page),
    pageSize: "50",
  });
  const { data, error, reload } = useRemote<Ageing>(
    valid ? `/api/reports/ageing?${query}` : null,
  );
  const who = side === "receivables" ? "Customers" : "Suppliers";
  return (
    <div className="space-y-6">
      <div className={`${CARD} grid items-end gap-4 sm:grid-cols-3`}>
        <Field id="ageing-side" label="Show">
          {(control) => (
            <select
              {...control}
              value={side}
              onChange={(e) => {
                setSide(e.target.value as typeof side);
                setPage(1);
              }}
            >
              <option value="receivables">Owed to you (customers)</option>
              <option value="payables">You owe (suppliers)</option>
            </select>
          )}
        </Field>
        <Field
          id="ageing-as-at"
          label="As at the end of"
          error={valid ? undefined : "Choose a date"}
        >
          {(control) => (
            <input
              {...control}
              type="date"
              value={asAt}
              onChange={(e) => {
                setAsAt(e.target.value);
                setPage(1);
              }}
            />
          )}
        </Field>
        {canExport && valid ? (
          <ExportLink
            href={`/api/exports/ageing?${new URLSearchParams({ side, asAt })}`}
          >
            Export CSV
          </ExportLink>
        ) : null}
      </div>
      {!valid ? null : error ? (
        <Failure error={error} reload={reload} />
      ) : !data ? (
        <p role="status">Loading what&apos;s owed…</p>
      ) : !data.rows.length && data.rowsPage.total === 0 ? (
        <Empty
          title="Nothing owed"
          text={`Nothing was outstanding at the end of ${day(asAt)}.`}
        />
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {BUCKETS.map((b) => (
              <Figure key={b.key} label={b.label}>
                {money(data.totals[b.key], "incl GST")}
              </Figure>
            ))}
            <Figure label="Total">
              {money(data.totals.total, "incl GST")}
            </Figure>
          </dl>
          <section className="space-y-3" aria-labelledby="ageing-parties">
            <h2 id="ageing-parties" className="text-xl font-semibold">
              {who}
            </h2>
            <ul className="space-y-2">
              {data.parties.map((p) => (
                <li
                  key={p.partyId ?? "none"}
                  className={`${CARD} grid gap-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]`}
                >
                  <span className="font-semibold [overflow-wrap:anywhere]">
                    {p.partyName || "Unnamed"}
                  </span>
                  <span>
                    Overdue{" "}
                    {money(
                      (BigInt(p.total) - BigInt(p.current)).toString(),
                      "incl GST",
                    )}
                  </span>
                  <span>Total {money(p.total, "incl GST")}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-3" aria-labelledby="ageing-rows">
            <h2 id="ageing-rows" className="text-xl font-semibold">
              Documents
            </h2>
            <ul className="space-y-2" aria-label="Outstanding documents">
              {data.rows.map((row) => (
                <li
                  key={row.id}
                  className={`${CARD} grid gap-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center`}
                >
                  <span className="min-w-0">
                    <Link
                      className={LINK}
                      href={
                        side === "receivables"
                          ? `/invoices/${row.id}`
                          : `/payments/bills/${row.id}`
                      }
                    >
                      {row.partyName}
                      {row.reference ? ` · ${row.reference}` : ""}
                    </Link>
                    <span className="block text-sm text-muted-foreground">
                      Due {day(row.dueOn)}
                    </span>
                  </span>
                  <span>
                    {row.daysOverdue
                      ? `${row.daysOverdue} days overdue`
                      : "Not yet due"}
                  </span>
                  <span className="sm:text-right">
                    {money(row.owed, "incl GST")}
                  </span>
                </li>
              ))}
            </ul>
            <Paging
              page={data.rowsPage}
              label="Outstanding document pages"
              onPage={setPage}
            />
          </section>
        </>
      )}
    </div>
  );
}

function CashView({
  range,
  canExport,
}: {
  range: { from: string; to: string };
  canExport: boolean;
}) {
  const { data, error, reload } = useRemote<Cash>(
    `/api/reports/cash?${new URLSearchParams(range)}`,
  );
  if (error) return <Failure error={error} reload={reload} />;
  if (!data) return <p role="status">Loading cash movement…</p>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold">{data.label}</p>
        {canExport ? (
          <ExportLink href={`/api/exports/cash?${new URLSearchParams(range)}`}>
            Export CSV
          </ExportLink>
        ) : null}
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Figure label="Money in">{money(data.moneyIn, "incl GST")}</Figure>
        <Figure label="Money out">{money(data.moneyOut, "incl GST")}</Figure>
        <Figure label="Net cash" note="Not profit: see Job profit">
          {money(data.net, "incl GST")}
        </Figure>
      </dl>
      {data.months.length ? (
        <ul className="space-y-2" aria-label="By month">
          {data.months.map((m) => (
            <li
              key={m.month}
              className={`${CARD} grid gap-1 sm:grid-cols-4 sm:items-center`}
            >
              <span className="font-semibold">
                {new Intl.DateTimeFormat("en-AU", {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                }).format(new Date(`${m.month}-01T00:00:00Z`))}
              </span>
              <span>In {money(m.moneyIn, "incl GST")}</span>
              <span>Out {money(m.moneyOut, "incl GST")}</span>
              <span className="font-semibold">
                Net {money(m.net, "incl GST")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          title="No money in or out"
          text="No receipts or payments were recorded in this range."
        />
      )}
    </div>
  );
}

export function ReportsHub({
  views,
  view,
  today,
  canExport,
}: {
  views: readonly ReportView[];
  view: ReportView;
  today: string;
  canExport: boolean;
}) {
  const [range, setRange] = useState(() => {
    const quarter = presets(today)[0]!;
    return { from: quarter.from, to: quarter.to };
  });
  const key = `${range.from}:${range.to}`;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Job profit ex GST, the draft GST summary, what's owed and cash movement. Figures come straight from your records; nothing is lodged."
      />
      <nav aria-label="Reports" className="flex flex-wrap gap-2">
        {views.map((item) => (
          <Link
            key={item}
            href={`/reports?view=${item}`}
            aria-current={item === view ? "page" : undefined}
            className={buttonVariants({
              variant: item === view ? "default" : "outline",
            })}
          >
            {VIEW_LABEL[item]}
          </Link>
        ))}
      </nav>
      {view === "ageing" ? (
        <AgeingView today={today} canExport={canExport} />
      ) : (
        <>
          <RangeFilter today={today} range={range} onChange={setRange} />
          {view === "profitability" ? (
            <ProfitView key={key} range={range} canExport={canExport} />
          ) : view === "gst" ? (
            <GstView key={key} range={range} canExport={canExport} />
          ) : (
            <CashView key={key} range={range} canExport={canExport} />
          )}
        </>
      )}
    </div>
  );
}
