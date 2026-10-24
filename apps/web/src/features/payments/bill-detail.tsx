"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { FormMessage, sendJson } from "@/components/form/field";
import { formatAudCents } from "@/components/money-display";
import { useRemote } from "@/components/data/use-remote";
import { BILL_STATUS, type Bill, taxLabel } from "./types";
import { VoidButton } from "./void-dialog";

const aud = (cents: string) => `${formatAudCents(BigInt(cents))} AUD`;

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 ${strong ? "font-semibold" : ""}`}
    >
      <dt>{label}</dt>
      <dd className="shrink-0 text-right whitespace-nowrap tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/** A recorded bill: what’s owed (obligation) and what’s been paid against it. */
export function BillDetail({
  id,
  canVoid,
  canPay,
  recorded,
}: {
  id: string;
  canVoid: boolean;
  canPay: boolean;
  recorded: boolean;
}) {
  const remote = useRemote<Bill>(`/api/bills/${id}`);
  const [local, setLocal] = useState<Bill | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(recorded ? { kind: "success", text: "Bill recorded." } : null);
  const [link, setLink] = useState<string | null>(null);
  const bill = local ?? remote.data;
  const job = useRemote<{ reference: string; title: string }>(
    bill?.jobId ? `/api/jobs/${bill.jobId}` : null,
  );
  if (remote.error && !bill)
    return (
      <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
        <p>{remote.error}</p>
        <Button onClick={remote.reload}>Try again</Button>
      </div>
    );
  if (!bill) return <p role="status">Loading bill…</p>;
  const title = `Bill from ${bill.supplierName}`;
  return (
    <>
      <PageHeader
        title={title}
        description={`${BILL_STATUS[bill.status]} · dated ${bill.issuedOn}${bill.dueOn ? ` · due ${bill.dueOn}` : ""}`}
        breadcrumbs={[
          { label: "Payments", href: "/payments?view=bills" },
          { label: bill.supplierReference ?? "Bill" },
        ]}
        actions={
          <div className="flex flex-wrap gap-3">
            {canPay && bill.status === "open" ? (
              <Button asChild>
                <Link href={`/payments/supplier/new?billId=${bill.id}`}>
                  Record payment
                </Link>
              </Button>
            ) : null}
            {canVoid && bill.status !== "void" ? (
              <VoidButton
                url={`/api/bills/${bill.id}/void`}
                label="bill"
                consequence="Its job cost and GST credit are reversed."
                onVoided={(body) => {
                  setLocal(body as Bill);
                  setMessage({ kind: "success", text: "Bill voided." });
                }}
              />
            ) : null}
          </div>
        }
      />
      <FormMessage message={message} />
      {bill.status === "void" ? (
        <p className="rounded-lg bg-warning p-4 text-warning-foreground">
          Void: {bill.voidReason}
        </p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section
            aria-labelledby="bill-supplier"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="bill-supplier" className="text-xl font-semibold">
              Supplier and job
            </h2>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">Supplier</dt>
                <dd className="[overflow-wrap:anywhere]">
                  {bill.supplierName}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">ABN</dt>
                <dd>{bill.supplierAbn ?? "Not provided"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  GST registered
                </dt>
                <dd>{bill.supplierGstRegistered ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  Supplier’s bill number
                </dt>
                <dd>{bill.supplierReference ?? "Not provided"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-sm text-muted-foreground">Job</dt>
                <dd>
                  {bill.jobId ? (
                    <Link className="underline" href={`/jobs/${bill.jobId}`}>
                      {job.data
                        ? `${job.data.reference} · ${job.data.title}`
                        : "Open job"}
                    </Link>
                  ) : (
                    "Overhead — no job"
                  )}
                </dd>
              </div>
              {bill.note ? (
                <div className="sm:col-span-2">
                  <dt className="text-sm text-muted-foreground">
                    Internal note
                  </dt>
                  <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {bill.note}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
          <section
            aria-labelledby="bill-lines"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="bill-lines" className="text-xl font-semibold">
              Lines
            </h2>
            <ol className="space-y-3">
              {bill.lines.map((line, index) => (
                <li key={line.position} className="rounded-lg border p-4">
                  <p className="font-semibold [overflow-wrap:anywhere]">
                    {index + 1}. {line.description}
                  </p>
                  <p className="text-sm tabular-nums">
                    {taxLabel(line.taxCode)} ·{" "}
                    {formatAudCents(BigInt(line.exclusiveCents))} ex GST ·{" "}
                    {formatAudCents(BigInt(line.gstCents))} GST ·{" "}
                    {formatAudCents(BigInt(line.inclusiveCents))} incl GST
                  </p>
                </li>
              ))}
            </ol>
          </section>
          <section
            aria-labelledby="bill-payments"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="bill-payments" className="text-xl font-semibold">
              Payments against this bill
            </h2>
            {!bill.payments.length ? (
              <p>No payments yet.</p>
            ) : (
              <ul className="space-y-2">
                {bill.payments.map((payment) => (
                  <li
                    key={payment.paymentId}
                    className="flex flex-wrap justify-between gap-2"
                  >
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      href={`/payments/supplier/${payment.paymentId}`}
                    >
                      Paid {payment.paidOn}
                      {payment.void ? " (void)" : ""}
                    </Link>
                    <span className="tabular-nums">
                      {aud(payment.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="space-y-4">
          <section
            aria-labelledby="bill-owed"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="bill-owed" className="text-xl font-semibold">
              Owed · AUD
            </h2>
            <dl className="space-y-2">
              <Row label="Ex GST" value={aud(bill.exclusiveCents)} />
              <Row label="GST" value={aud(bill.gstCents)} />
              <Row
                label="Total incl GST"
                value={aud(bill.inclusiveCents)}
                strong
              />
              <Row label="Paid" value={aud(bill.paidCents)} />
              <Row
                label="Still owing"
                value={aud(bill.outstandingCents)}
                strong
              />
            </dl>
          </section>
          <section
            aria-labelledby="bill-gst"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="bill-gst" className="text-xl font-semibold">
              GST and job cost
            </h2>
            <dl className="space-y-2">
              <Row
                label="Claimable GST credit"
                value={aud(bill.creditableGstCents)}
              />
              <Row
                label="GST not claimable"
                value={aud(bill.nonCreditableGstCents)}
              />
              <Row
                label="Job cost (ex GST + unclaimable GST)"
                value={aud(bill.jobCostCents)}
                strong
              />
            </dl>
            <p className="text-sm text-muted-foreground">
              {!bill.companyGstRegistered
                ? "Not registered for GST on the bill date: no GST credit."
                : bill.hasEvidence
                  ? `Tax invoice held · ${bill.creditablePercent}% business use${bill.creditableReason ? ` (${bill.creditableReason})` : ""}.`
                  : "No verified evidence held, so none of its GST can be claimed (over $82.50 needs a tax invoice)."}
            </p>
            {bill.documentId ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const result = await sendJson(
                      `/api/documents/${bill.documentId}/link`,
                      "POST",
                      {},
                    );
                    if (!result.ok)
                      setMessage({ kind: "error", text: result.message });
                    else setLink((result.body as { url: string }).url);
                  }}
                >
                  Create document link
                </Button>
                {link ? (
                  <p>
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={link}
                    >
                      Open the supplier’s document
                    </a>
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </aside>
      </div>
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/payments?view=bills"
        >
          Back to bills
        </Link>
      </p>
    </>
  );
}
