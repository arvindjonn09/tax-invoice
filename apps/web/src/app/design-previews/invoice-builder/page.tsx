import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MoneyDisplay } from "@/components/money-display";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { PreviewShell, SpecimenNav } from "@/components/preview/preview-shell";

export const metadata: Metadata = {
  title: "Invoice builder preview · JobFlow",
};

type Line = {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: number;
  treatment: string;
  exclusive: number;
  gst: number;
  inclusive: number;
};
type Specimen = {
  label: string;
  title: "Tax Invoice" | "Invoice";
  note?: string;
  lines: readonly Line[];
  totals: { exclusive: number; gst: number; inclusive: number };
};

/** Transcribed from docs/design/screens/invoice-builder.md — never calculated here. */
const SPECIMENS: Record<string, Specimen> = {
  registered: {
    label: "Registered",
    title: "Tax Invoice",
    lines: [
      {
        description: "Sample service",
        quantity: "1",
        unit: "each",
        unitPrice: 250000,
        treatment: "Taxable — 10%",
        exclusive: 250000,
        gst: 25000,
        inclusive: 275000,
      },
    ],
    totals: { exclusive: 250000, gst: 25000, inclusive: 275000 },
  },
  mixed: {
    label: "Mixed GST codes",
    title: "Tax Invoice",
    note: "Layout sample only, not GST classification advice.",
    lines: [
      {
        description: "Sample taxable service",
        quantity: "1",
        unit: "each",
        unitPrice: 10000,
        treatment: "Taxable — 10%",
        exclusive: 10000,
        gst: 1000,
        inclusive: 11000,
      },
      {
        description: "Sample GST-free service",
        quantity: "1",
        unit: "each",
        unitPrice: 5000,
        treatment: "GST-free — 0%",
        exclusive: 5000,
        gst: 0,
        inclusive: 5000,
      },
      {
        description: "Sample input-taxed service",
        quantity: "1",
        unit: "each",
        unitPrice: 2000,
        treatment: "Input taxed — 0%",
        exclusive: 2000,
        gst: 0,
        inclusive: 2000,
      },
      {
        description: "Sample out-of-scope item",
        quantity: "2",
        unit: "hrs",
        unitPrice: 1500,
        treatment: "Out of scope — 0%",
        exclusive: 3000,
        gst: 0,
        inclusive: 3000,
      },
    ],
    totals: { exclusive: 20000, gst: 1000, inclusive: 21000 },
  },
  unregistered: {
    label: "Not GST registered",
    title: "Invoice",
    note: "Not GST registered — no GST charged.",
    lines: [
      {
        description: "Sample service",
        quantity: "1",
        unit: "each",
        unitPrice: 250000,
        treatment: "Out of scope — 0%",
        exclusive: 250000,
        gst: 0,
        inclusive: 250000,
      },
    ],
    totals: { exclusive: 250000, gst: 0, inclusive: 250000 },
  },
};

function Field({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  const id = `field-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        disabled
        readOnly
        aria-describedby={help ? `${id}-help` : undefined}
        className="min-h-11 rounded-sm border border-control-border bg-muted px-4 text-muted-foreground"
      />
      {help ? (
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
}

function Panel({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      aria-labelledby={`${title}-h`}
      className="space-y-4 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h2 id={`${title}-h`} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function InvoiceBuilderPreview({
  searchParams,
}: {
  searchParams: Promise<{ specimen?: string }>;
}) {
  const requested = (await searchParams).specimen ?? "registered";
  const key = requested in SPECIMENS ? requested : "registered";
  const specimen = SPECIMENS[key] as Specimen;
  return (
    <PreviewShell>
      <div className="space-y-6 pb-24 md:pb-0">
        <PageHeader
          title={specimen.title}
          description="Draft · Not issued · Invoice number assigned on issue"
          breadcrumbs={[
            { label: "Design previews", href: "/design-previews" },
            { label: "New invoice" },
          ]}
          actions={
            <>
              <Button variant="outline" disabled>
                Save draft
              </Button>
              <Button variant="outline" disabled>
                Preview PDF
              </Button>
              <Button disabled>Review and issue</Button>
            </>
          }
        />
        <p className="text-sm text-muted-foreground">
          Static layout preview. Financial actions are unavailable; buttons are
          disabled samples.
        </p>
        <SpecimenNav
          label="Invoice specimens"
          current={key}
          options={Object.entries(SPECIMENS).map(([value, s]) => ({
            value,
            label: s.label,
            href: `?specimen=${value}`,
          }))}
        />
        {specimen.note ? (
          <p className="rounded-lg border bg-muted p-4 text-muted-foreground">
            {specimen.note}
          </p>
        ) : null}
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <Panel title="Details">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Customer" value="Sample Customer A" />
                <Field label="Job" value="Sample Job 001" />
                <Field
                  label="Customer reference / PO number (optional)"
                  value="Sample PO 0001"
                  help="Printed on the invoice when filled."
                />
                <Field
                  label="Service location (site address) (optional)"
                  value="Sample Site 1"
                  help="Must belong to this customer or job."
                />
                <Field
                  label="Issue date (Australia/Sydney)"
                  value="Sample date"
                />
                <Field label="Payment due date" value="Sample date" />
              </div>
              <p className="text-sm text-muted-foreground">
                Supplier identity and ABN come from company settings; recipient
                details come from the customer record.
              </p>
            </Panel>
            <Panel title="Lines">
              <fieldset disabled className="space-y-2">
                <legend>Prices entered</legend>
                <label className="mr-4">
                  <input type="radio" name="entry" defaultChecked readOnly /> Ex
                  GST
                </label>
                <label>
                  <input type="radio" name="entry" readOnly /> Incl GST
                </label>
              </fieldset>
              <ol className="space-y-4 md:hidden">
                {specimen.lines.map((line, index) => (
                  <li key={line.description}>
                    <fieldset className="space-y-1 rounded-lg border p-4">
                      <legend className="font-semibold">
                        Line {index + 1}
                      </legend>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                        <dt>Description</dt>
                        <dd>{line.description}</dd>
                        <dt>Quantity</dt>
                        <dd className="tabular-nums">
                          {line.quantity} {line.unit}
                        </dd>
                        <dt>Unit price</dt>
                        <dd>
                          <MoneyDisplay cents={line.unitPrice} basis="ex GST" />
                        </dd>
                        <dt>GST treatment</dt>
                        <dd>{line.treatment}</dd>
                        <dt>Ex GST</dt>
                        <dd>
                          <MoneyDisplay cents={line.exclusive} basis="ex GST" />
                        </dd>
                        <dt>GST</dt>
                        <dd className="tabular-nums">
                          ${(line.gst / 100).toFixed(2)}
                        </dd>
                        <dt>Incl GST</dt>
                        <dd>
                          <MoneyDisplay
                            cents={line.inclusive}
                            basis="incl GST"
                          />
                        </dd>
                      </dl>
                    </fieldset>
                  </li>
                ))}
              </ol>
              <div
                role="region"
                aria-label="Invoice lines table (scrolls sideways)"
                tabIndex={0}
                className="hidden overflow-x-auto md:block"
              >
                <table className="w-full min-w-[720px] text-left text-sm">
                  <caption className="sr-only">Invoice lines (sample)</caption>
                  <thead>
                    <tr>
                      {[
                        "Description",
                        "Qty",
                        "Unit",
                        "Unit price",
                        "GST treatment",
                        "Ex GST",
                        "GST",
                        "Incl GST",
                      ].map((h) => (
                        <th key={h} scope="col" className="px-2 py-2">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {specimen.lines.map((line) => (
                      <tr key={line.description} className="border-t">
                        <td className="px-2 py-2">{line.description}</td>
                        <td className="px-2 py-2 tabular-nums">
                          {line.quantity}
                        </td>
                        <td className="px-2 py-2">{line.unit}</td>
                        <td className="px-2 py-2">
                          <MoneyDisplay cents={line.unitPrice} basis="ex GST" />
                        </td>
                        <td className="px-2 py-2">{line.treatment}</td>
                        <td className="px-2 py-2">
                          <MoneyDisplay cents={line.exclusive} basis="ex GST" />
                        </td>
                        <td className="px-2 py-2 tabular-nums">
                          ${(line.gst / 100).toFixed(2)}
                        </td>
                        <td className="px-2 py-2">
                          <MoneyDisplay
                            cents={line.inclusive}
                            basis="incl GST"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button variant="outline" disabled>
                Add line
              </Button>
            </Panel>
          </div>
          <Panel title="Totals" id="totals">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
              <dt>Subtotal</dt>
              <dd>
                <MoneyDisplay
                  cents={specimen.totals.exclusive}
                  basis="ex GST"
                />
              </dd>
              <dt>GST</dt>
              <dd className="tabular-nums">
                ${(specimen.totals.gst / 100).toFixed(2)} AUD
              </dd>
              <dt className="font-semibold">Total</dt>
              <dd className="font-semibold">
                <MoneyDisplay
                  cents={specimen.totals.inclusive}
                  basis="incl GST"
                />
              </dd>
            </dl>
            <p className="text-sm text-muted-foreground">
              Required before issue: customer, at least one valid line, issue
              and due dates.
            </p>
            <p className="text-sm text-muted-foreground">
              On issue, this document is snapshotted and becomes read-only.
              Corrections use a credit note or void.
            </p>
          </Panel>
        </div>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-card px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-card-foreground md:hidden [@media(max-height:480px)]:static">
        <p className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">
            Total{" "}
            <MoneyDisplay cents={specimen.totals.inclusive} basis="incl GST" />
          </span>
          <a
            href="#totals"
            className="inline-flex min-h-11 items-center underline"
          >
            View breakdown
          </a>
        </p>
      </div>
    </PreviewShell>
  );
}
