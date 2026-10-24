"use client";
import { PageHeader } from "@/components/shell/page-header";
import { useRemote } from "@/components/data/use-remote";
import { day } from "@/features/jobs/types";
import { InvoiceLines } from "./lines";
import { Totals } from "./totals";
import type { Invoice } from "./types";

/**
 * A draft for roles that can read invoices but not edit them (managers):
 * the last saved lines and totals, with no form controls.
 */
export function DraftInvoiceView({
  invoice,
  registered,
  creditsReference,
}: {
  invoice: Invoice;
  /** GST registration the draft would issue under (decided on issue). */
  registered: boolean | null;
  creditsReference: string | null;
}) {
  const isCredit = invoice.kind === "credit_note";
  const customer = useRemote<{ name: string }>(
    `/api/customers/${invoice.customerId}`,
  );
  const name = isCredit ? "credit note" : "invoice";
  return (
    <>
      <PageHeader
        title={`Draft ${name}`}
        description={
          isCredit && creditsReference
            ? `Draft credit note for ${creditsReference} · Not issued · Read only`
            : "Draft · Not issued · Read only"
        }
        breadcrumbs={[
          { label: "Invoices", href: "/invoices" },
          { label: `Draft ${name}` },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        You can view this draft; an owner or accountant edits and issues it.
      </p>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="space-y-2 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]">
            <p>
              Customer: <strong>{customer.data?.name ?? "Loading…"}</strong>
            </p>
            {invoice.customerReference ? (
              <p>Customer reference: {invoice.customerReference}</p>
            ) : null}
            {invoice.dueOn ? <p>Due {day(invoice.dueOn)}</p> : null}
          </section>
          <section
            aria-labelledby="lines-heading"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="lines-heading" className="text-xl font-semibold">
              Lines
            </h2>
            {invoice.lines.length ? (
              <InvoiceLines invoice={invoice} />
            ) : (
              <p>No lines yet.</p>
            )}
            {invoice.notes ? (
              <>
                <h3 className="font-semibold">Notes</h3>
                <p className="whitespace-pre-wrap">{invoice.notes}</p>
              </>
            ) : null}
          </section>
        </div>
        <aside>
          <Totals totals={invoice} stale={false} registered={registered} />
        </aside>
      </div>
    </>
  );
}
