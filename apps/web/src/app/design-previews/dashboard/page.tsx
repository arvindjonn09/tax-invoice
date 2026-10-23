import type { Metadata } from "next";
import { MoneyDisplay } from "@/components/money-display";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/shell/states";
import { StatusPill } from "@/components/status-pill";
import {
  PreviewShell,
  SampleMetric,
  SpecimenNav,
} from "@/components/preview/preview-shell";

export const metadata: Metadata = { title: "Dashboard preview · JobFlow" };

const STATES = [
  { value: "success", label: "Sample values" },
  { value: "loading", label: "Loading" },
  { value: "empty", label: "Empty" },
  { value: "error", label: "Error" },
] as const;
type State = (typeof STATES)[number]["value"];

/**
 * M0 static preview of docs/design/screens/dashboard.md. Every amount is a
 * transcribed sample from the registered combined fixture (docs/GST.md);
 * nothing is queried or calculated, and no control performs an action.
 */
export default async function DashboardPreview({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const requested = (await searchParams).state;
  const state: State = STATES.some((s) => s.value === requested)
    ? (requested as State)
    : "success";
  return (
    <PreviewShell>
      <PageHeader
        title="Dashboard"
        description="AUD · Sample period · Australia/Sydney · Sample values (not refreshed)"
        breadcrumbs={[
          { label: "Design previews", href: "/design-previews" },
          { label: "Dashboard" },
        ]}
      />
      <SpecimenNav
        label="Dashboard state specimens"
        current={state}
        options={STATES.map((s) => ({ ...s, href: `?state=${s.value}` }))}
      />
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          Period
          <select
            disabled
            className="min-h-11 rounded-sm border border-control-border bg-card px-4"
          >
            <option>This month</option>
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          Period filter is a static sample in this preview.
        </p>
      </div>
      {state === "loading" ? <LoadingSpecimen /> : null}
      {state === "empty" ? (
        <EmptyState
          title="No activity in this period."
          description="No jobs yet. Real figures appear once jobs, invoices and costs are recorded (M1–M4)."
        />
      ) : null}
      {state === "error" ? (
        <ErrorState
          title="Dashboard could not be loaded."
          message="Try again. Your selected period is kept."
          reference="sample-ref-0001"
        />
      ) : null}
      {state === "success" ? <SuccessSpecimen /> : null}
    </PreviewShell>
  );
}

function LoadingSpecimen() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading dashboard"
      className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
    >
      {["Invoiced revenue", "Incurred cost", "Gross profit"].map((label) => (
        <div key={label} className="space-y-2 rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="h-10 rounded-sm bg-muted" aria-hidden="true" />
          <p className="sr-only">Loading {label}</p>
        </div>
      ))}
    </section>
  );
}

function SuccessSpecimen() {
  return (
    <>
      <section aria-labelledby="profit" className="space-y-4">
        <h2 id="profit" className="text-xl font-semibold">
          Profit and costs
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <SampleMetric label="Invoiced revenue">
            <MoneyDisplay cents={250000} basis="ex GST" />
          </SampleMetric>
          <SampleMetric
            label="Incurred cost"
            note="Ex GST + non-creditable GST"
          >
            <MoneyDisplay cents={145000} basis="ex GST" />
          </SampleMetric>
          <SampleMetric label="Gross profit" note="Margin 42% · invoiced basis">
            <MoneyDisplay cents={105000} basis="ex GST" />
          </SampleMetric>
        </div>
      </section>
      <section aria-labelledby="cash" className="space-y-4">
        <h2 id="cash" className="text-xl font-semibold">
          Cash movement
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <SampleMetric label="Received">
            <MoneyDisplay cents={100000} basis="incl GST" />
          </SampleMetric>
          <SampleMetric label="Paid">
            <MoneyDisplay cents={66500} basis="incl GST" />
          </SampleMetric>
          <SampleMetric label="Net cash" note="Cash movement, not profit">
            <MoneyDisplay cents={33500} basis="incl GST" />
          </SampleMetric>
        </div>
        <ul className="list-disc space-y-1 pl-6 text-sm text-muted-foreground">
          <li>
            Sample assumption: materials and travel paid at purchase. In JobFlow
            each expense records whether it was paid now or put on account.
          </li>
          <li>
            Employee labour is an internal cost; wages are not tracked as
            payments.
          </li>
        </ul>
      </section>
      <section aria-labelledby="balances" className="space-y-4">
        <h2 id="balances" className="text-xl font-semibold">
          Outstanding balances
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <SampleMetric
            label="Customer outstanding"
            note="Overdue invoices: 1 — the overdue list arrives in M3/M4 (link unavailable in this preview)"
          >
            <MoneyDisplay cents={175000} basis="incl GST" />
          </SampleMetric>
          <SampleMetric
            label="Supplier outstanding"
            note="Remaining subcontractor bill only"
          >
            <MoneyDisplay cents={59000} basis="incl GST" />
          </SampleMetric>
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-3">
        <section
          aria-labelledby="jobs"
          className="min-w-0 space-y-4 lg:col-span-2"
        >
          <h2 id="jobs" className="text-xl font-semibold">
            Recent jobs
          </h2>
          <div className="overflow-x-auto rounded-lg border bg-card text-card-foreground">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Recent jobs (sample)</caption>
              <thead>
                <tr>
                  {["Job", "Customer", "Status", "Due"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="px-4 py-2">Sample Job 001</td>
                  <td className="px-4 py-2">Sample Customer A</td>
                  <td className="px-4 py-2">
                    <StatusPill status="completed" />
                  </td>
                  <td className="px-4 py-2">Sample date</td>
                </tr>
                <tr className="border-t">
                  <td className="px-4 py-2">Sample Job 002</td>
                  <td className="px-4 py-2">Sample Customer B</td>
                  <td className="px-4 py-2">
                    <StatusPill status="active" label="In progress" />
                  </td>
                  <td className="px-4 py-2">Sample date</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section
          aria-labelledby="gst"
          className="space-y-2 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <h2 id="gst" className="text-xl font-semibold">
            Draft BAS/GST summary
          </h2>
          <p className="text-sm">
            Not lodged · non-cash basis · ordinary-supply sample
          </p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
            <dt>G1 total sales</dt>
            <dd>
              <MoneyDisplay cents={275000} basis="incl GST" />
            </dd>
            <dt>1A GST on sales</dt>
            <dd>$250.00 AUD</dd>
            <dt>1B GST credits</dt>
            <dd>$105.00 AUD</dd>
            <dt>Indicative net GST payable</dt>
            <dd>$145.00 AUD</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
