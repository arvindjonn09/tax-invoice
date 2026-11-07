"use client";
import Link from "next/link";
import { useRemote } from "@/components/data/use-remote";
import { MoneyDisplay } from "@/components/money-display";
import { day, statusLabel, type Job } from "@/features/jobs/types";
import type { Invoice } from "@/features/invoices/types";

const INVOICE_STATUS: Record<Invoice["status"], string> = {
  draft: "Draft",
  issued: "Issued",
  void: "Void",
};

/** The customer's latest jobs and invoices, newest first (#307). */
export function CustomerHistory({ customerId }: { customerId: string }) {
  const query = new URLSearchParams({ customerId, pageSize: "10" });
  const jobs = useRemote<{ jobs: Job[]; total: number }>(`/api/jobs?${query}`);
  const invoices = useRemote<{ invoices: Invoice[]; total: number }>(
    `/api/invoices?${query}`,
  );
  return (
    <section
      aria-labelledby="customer-history"
      className="space-y-4 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]"
    >
      <h2 id="customer-history" className="text-xl font-semibold">
        Job and invoice history
      </h2>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <h3 className="font-semibold">Jobs</h3>
          {jobs.error ? (
            <p role="alert">{jobs.error}</p>
          ) : !jobs.data ? (
            <p role="status">Loading jobs…</p>
          ) : jobs.data.jobs.length ? (
            <ul className="space-y-1">
              {jobs.data.jobs.map((job) => (
                <li key={job.id}>
                  <Link
                    className="inline-flex min-h-11 items-center underline"
                    href={`/jobs/${job.id}`}
                  >
                    {job.reference} · {job.title}
                  </Link>{" "}
                  · {statusLabel(job.status)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              No jobs for this customer yet.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <h3 className="font-semibold">Invoices</h3>
          {invoices.error ? (
            <p role="alert">{invoices.error}</p>
          ) : !invoices.data ? (
            <p role="status">Loading invoices…</p>
          ) : invoices.data.invoices.length ? (
            <ul className="space-y-1">
              {invoices.data.invoices.map((invoice) => (
                <li key={invoice.id}>
                  <Link
                    className="inline-flex min-h-11 items-center underline"
                    href={`/invoices/${invoice.id}`}
                  >
                    {invoice.reference
                      ? `${invoice.title} ${invoice.reference}`
                      : invoice.kind === "credit_note"
                        ? "Draft credit note"
                        : "Draft invoice"}
                  </Link>{" "}
                  · {INVOICE_STATUS[invoice.status]}
                  {invoice.status !== "draft" ? (
                    <>
                      {" · "}
                      <MoneyDisplay
                        cents={BigInt(invoice.inclusiveCents)}
                        basis="incl GST"
                      />
                    </>
                  ) : null}
                  {invoice.issueDate ? ` · ${day(invoice.issueDate)}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              No invoices for this customer yet.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
