"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/form/field";
import { formatAudCents } from "@/components/money-display";
import { useRemote } from "@/components/data/use-remote";
import { type Receipt, type SupplierPayment, methodLabel } from "./types";
import { useAllPages } from "./use-all-pages";
import { VoidButton } from "./void-dialog";

const aud = (cents: string) => `${formatAudCents(BigInt(cents))} AUD`;

function Loading({
  error,
  reload,
  what,
}: {
  error?: string | undefined;
  reload: () => void;
  what: string;
}) {
  return error ? (
    <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
      <p>{error}</p>
      <Button onClick={reload}>Try again</Button>
    </div>
  ) : (
    <p role="status">Loading {what}…</p>
  );
}

function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="tabular-nums [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A supplier payment and the bills it settled. */
export function SupplierPaymentDetail({
  id,
  canVoid,
  recorded,
}: {
  id: string;
  canVoid: boolean;
  recorded: boolean;
}) {
  const remote = useRemote<SupplierPayment>(`/api/supplier-payments/${id}`);
  const [local, setLocal] = useState<SupplierPayment | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(recorded ? { kind: "success", text: "Payment recorded." } : null);
  const payment = local ?? remote.data;
  if (!payment)
    return (
      <Loading error={remote.error} reload={remote.reload} what="payment" />
    );
  return (
    <>
      <PageHeader
        title={`Payment to ${payment.payeeName}`}
        description={payment.voidedAt ? "Void" : `Paid ${payment.paidOn}`}
        breadcrumbs={[
          { label: "Payments", href: "/payments?view=payments" },
          { label: "Supplier payment" },
        ]}
        actions={
          canVoid && !payment.voidedAt ? (
            <VoidButton
              url={`/api/supplier-payments/${payment.id}/void`}
              label="payment"
              consequence="The bills it settled become owing again."
              onVoided={(body) => {
                setLocal(body as SupplierPayment);
                setMessage({ kind: "success", text: "Payment voided." });
              }}
            />
          ) : null
        }
      />
      <FormMessage message={message} />
      {payment.voidedAt ? (
        <p className="rounded-lg bg-warning p-4 text-warning-foreground">
          Void: {payment.voidReason}
        </p>
      ) : null}
      <section
        aria-labelledby="payment-facts"
        className="space-y-3 rounded-lg border bg-card p-6"
      >
        <h2 id="payment-facts" className="text-xl font-semibold">
          Payment
        </h2>
        <Facts
          items={[
            ["Amount", aud(payment.amountCents)],
            ["Paid on", payment.paidOn],
            ["Method", methodLabel(payment.method)],
            ["Reference", payment.reference ?? "None"],
          ]}
        />
      </section>
      <section
        aria-labelledby="payment-bills"
        className="space-y-3 rounded-lg border bg-card p-6"
      >
        <h2 id="payment-bills" className="text-xl font-semibold">
          Bills settled
        </h2>
        <ul className="space-y-2">
          {payment.allocations.map((allocation) => (
            <li
              key={allocation.billId}
              className="flex flex-wrap justify-between gap-2"
            >
              <Link
                className="inline-flex min-h-11 items-center underline"
                href={`/payments/bills/${allocation.billId}`}
              >
                Open bill
              </Link>
              <span className="tabular-nums">
                {aud(allocation.amountCents)} · GST credit on payment{" "}
                {aud(allocation.creditableGstAttributedCents)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/payments?view=payments"
        >
          Back to supplier payments
        </Link>
      </p>
    </>
  );
}

/** A customer receipt or refund and the invoices it settled. */
export function ReceiptDetail({
  id,
  canVoid,
  recorded,
}: {
  id: string;
  canVoid: boolean;
  recorded: boolean;
}) {
  const remote = useRemote<Receipt>(`/api/receipts/${id}`);
  const [local, setLocal] = useState<Receipt | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const receipt = local ?? remote.data;
  const customer = useRemote<{ name: string }>(
    receipt ? `/api/customers/${receipt.customerId}` : null,
  );
  const invoices = useAllPages<{ id: string; reference: string | null }>(
    receipt
      ? `/api/invoices?${new URLSearchParams({ customerId: receipt.customerId, kind: "invoice" })}`
      : null,
    "invoices",
  );
  const references = new Map(
    (invoices.rows ?? []).map((invoice) => [
      invoice.id,
      invoice.reference ?? "",
    ]),
  );
  if (!receipt)
    return (
      <Loading error={remote.error} reload={remote.reload} what="receipt" />
    );
  const noun = receipt.kind === "refund" ? "refund" : "receipt";
  const shown =
    message ??
    (recorded
      ? {
          kind: "success" as const,
          text: `${noun === "refund" ? "Refund" : "Receipt"} recorded.`,
        }
      : null);
  return (
    <>
      <PageHeader
        title={`${noun === "refund" ? "Refund to" : "Receipt from"} ${customer.data?.name ?? "customer"}`}
        description={
          receipt.voidedAt
            ? "Void"
            : `${noun === "refund" ? "Refunded" : "Received"} ${receipt.receivedOn}`
        }
        breadcrumbs={[
          { label: "Payments", href: "/payments?view=receipts" },
          { label: noun === "refund" ? "Refund" : "Receipt" },
        ]}
        actions={
          canVoid && !receipt.voidedAt ? (
            <VoidButton
              url={`/api/receipts/${receipt.id}/void`}
              label={noun}
              consequence={
                noun === "refund"
                  ? "The invoices it refunded count as paid again."
                  : "The invoices it settled become owing again."
              }
              onVoided={(body) => {
                setLocal(body as Receipt);
                setMessage({
                  kind: "success",
                  text: `${noun === "refund" ? "Refund" : "Receipt"} voided.`,
                });
              }}
            />
          ) : null
        }
      />
      <FormMessage message={shown} />
      {receipt.voidedAt ? (
        <p className="rounded-lg bg-warning p-4 text-warning-foreground">
          Void: {receipt.voidReason}
        </p>
      ) : null}
      <section
        aria-labelledby="receipt-facts"
        className="space-y-3 rounded-lg border bg-card p-6"
      >
        <h2 id="receipt-facts" className="text-xl font-semibold">
          {noun === "refund" ? "Refund" : "Receipt"}
        </h2>
        <Facts
          items={[
            ["Amount", aud(receipt.amountCents)],
            [
              noun === "refund" ? "Refunded on" : "Received on",
              receipt.receivedOn,
            ],
            ["Method", methodLabel(receipt.method)],
            ["Reference", receipt.reference ?? "None"],
          ]}
        />
      </section>
      <section
        aria-labelledby="receipt-invoices"
        className="space-y-3 rounded-lg border bg-card p-6"
      >
        <h2 id="receipt-invoices" className="text-xl font-semibold">
          Invoices settled
        </h2>
        <ul className="space-y-2">
          {receipt.allocations.map((allocation) => (
            <li
              key={allocation.invoiceId}
              className="flex flex-wrap justify-between gap-2"
            >
              <span className="inline-flex min-h-11 items-center font-semibold">
                Invoice {references.get(allocation.invoiceId) ?? ""}
              </span>
              <span className="tabular-nums">
                {aud(allocation.amountCents)} · GST attributed{" "}
                {aud(allocation.gstAttributedCents)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/payments?view=receipts"
        >
          Back to customer receipts
        </Link>
      </p>
    </>
  );
}
