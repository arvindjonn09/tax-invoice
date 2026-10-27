"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Field } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { formatAudCents } from "@/components/money-display";
import { useRemote } from "@/components/data/use-remote";
import { SubmissionQueue } from "./submissions";
import {
  BILL_STATUS,
  type Bill,
  type Receipt,
  type SupplierPayment,
  methodLabel,
} from "./types";

export type View = "bills" | "payments" | "receipts";

const VIEWS: { value: View; label: string; description: string }[] = [
  {
    value: "bills",
    label: "Supplier bills",
    description: "What you owe: bills recorded from suppliers and contractors.",
  },
  {
    value: "payments",
    label: "Supplier payments",
    description: "Money you paid out, settling one or more bills.",
  },
  {
    value: "receipts",
    label: "Customer receipts",
    description:
      "Money received from customers (and refunds), settling invoices.",
  },
];

const aud = (cents: string) => `${formatAudCents(BigInt(cents))} AUD`;

function Paging({
  page,
  pageSize,
  total,
  label,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  label: string;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-3">
      <Button
        variant="outline"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </Button>
      <Button
        variant="outline"
        disabled={page * pageSize >= total}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
    </nav>
  );
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

const LINK =
  "inline-flex min-h-11 max-w-full items-center font-semibold underline [overflow-wrap:anywhere]";

function Bills({ canDecide }: { canDecide: boolean }) {
  const [status, setStatus] = useState("live");
  const [page, setPage] = useState(1);
  const { data, error, reload } = useRemote<{
    bills: Bill[];
    total: number;
    pageSize: number;
  }>(
    `/api/bills?${new URLSearchParams({ status, page: String(page), pageSize: "20" })}`,
  );
  return (
    <>
      <SubmissionQueue canDecide={canDecide} onDecided={reload} />
      <div className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <Field id="bill-status-filter" label="Show">
          {(control) => (
            <select
              {...control}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="live">Current bills</option>
              <option value="void">Void bills</option>
              <option value="all">All bills</option>
            </select>
          )}
        </Field>
      </div>
      {error ? (
        <Failure error={error} reload={reload} />
      ) : !data ? (
        <p role="status">Loading bills…</p>
      ) : !data.bills.length ? (
        <Empty
          title="No bills to show"
          text="Bills appear here when they're recorded."
        />
      ) : (
        <>
          <ul className="space-y-3" aria-label="Supplier bills">
            {data.bills.map((bill) => (
              <li
                key={bill.id}
                className="grid gap-2 rounded-lg border bg-card p-4 sm:grid-cols-[2fr_1fr_1fr]"
              >
                <div className="min-w-0">
                  <Link className={LINK} href={`/payments/bills/${bill.id}`}>
                    {bill.supplierName}
                    {bill.supplierReference
                      ? ` · ${bill.supplierReference}`
                      : ""}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    Dated {bill.issuedOn}
                    {bill.dueOn ? ` · due ${bill.dueOn}` : ""}
                  </p>
                </div>
                <p>
                  <span className="block text-sm text-muted-foreground">
                    Total
                  </span>
                  <span className="tabular-nums">
                    {aud(bill.inclusiveCents)} incl GST
                  </span>
                </p>
                <p>
                  <span className="block text-sm text-muted-foreground">
                    {BILL_STATUS[bill.status]}
                  </span>
                  <span className="tabular-nums">
                    {bill.status === "void"
                      ? "—"
                      : `${aud(bill.outstandingCents)} owing`}
                  </span>
                </p>
              </li>
            ))}
          </ul>
          <Paging
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            label="Bill pages"
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}

function Payments() {
  const [page, setPage] = useState(1);
  const { data, error, reload } = useRemote<{
    payments: SupplierPayment[];
    total: number;
    pageSize: number;
  }>(
    `/api/supplier-payments?${new URLSearchParams({ page: String(page), pageSize: "20" })}`,
  );
  if (error) return <Failure error={error} reload={reload} />;
  if (!data) return <p role="status">Loading payments…</p>;
  if (!data.payments.length)
    return (
      <Empty
        title="No supplier payments"
        text="Payments appear here when they're recorded."
      />
    );
  return (
    <>
      <ul className="space-y-3" aria-label="Supplier payments">
        {data.payments.map((payment) => (
          <li
            key={payment.id}
            className="grid gap-2 rounded-lg border bg-card p-4 sm:grid-cols-[2fr_1fr_1fr]"
          >
            <div className="min-w-0">
              <Link className={LINK} href={`/payments/supplier/${payment.id}`}>
                {payment.payeeName}
              </Link>
              <p className="text-sm text-muted-foreground">
                Paid {payment.paidOn} · {methodLabel(payment.method)}
              </p>
            </div>
            <p className="tabular-nums">{aud(payment.amountCents)}</p>
            <p>
              {payment.voidedAt
                ? "Void"
                : `${payment.allocations.length} ${payment.allocations.length === 1 ? "bill" : "bills"}`}
            </p>
          </li>
        ))}
      </ul>
      <Paging
        page={page}
        pageSize={data.pageSize}
        total={data.total}
        label="Payment pages"
        onPage={setPage}
      />
    </>
  );
}

function Receipts() {
  const [page, setPage] = useState(1);
  const { data, error, reload } = useRemote<{
    receipts: Receipt[];
    total: number;
    pageSize: number;
  }>(
    `/api/receipts?${new URLSearchParams({ page: String(page), pageSize: "20" })}`,
  );
  if (error) return <Failure error={error} reload={reload} />;
  if (!data) return <p role="status">Loading receipts…</p>;
  if (!data.receipts.length)
    return (
      <Empty
        title="No customer receipts"
        text="Receipts appear here when they're recorded."
      />
    );
  return (
    <>
      <ul className="space-y-3" aria-label="Customer receipts">
        {data.receipts.map((receipt) => (
          <li
            key={receipt.id}
            className="grid gap-2 rounded-lg border bg-card p-4 sm:grid-cols-[2fr_1fr_1fr]"
          >
            <div className="min-w-0">
              <Link className={LINK} href={`/payments/receipts/${receipt.id}`}>
                {receipt.kind === "refund" ? "Refund" : "Receipt"} of{" "}
                {receipt.receivedOn}
              </Link>
              <p className="text-sm text-muted-foreground">
                {methodLabel(receipt.method)}
              </p>
            </div>
            <p className="tabular-nums">
              {receipt.kind === "refund" ? "−" : ""}
              {aud(receipt.amountCents)}
            </p>
            <p>
              {receipt.voidedAt
                ? "Void"
                : `${receipt.allocations.length} ${receipt.allocations.length === 1 ? "invoice" : "invoices"}`}
            </p>
          </li>
        ))}
      </ul>
      <Paging
        page={page}
        pageSize={data.pageSize}
        total={data.total}
        label="Receipt pages"
        onPage={setPage}
      />
    </>
  );
}

/**
 * Obligations (bills) and settlements (payments, receipts) are separate
 * views: a bill is what's owed; a payment or receipt is money that moved.
 */
export function PaymentsHub({
  view,
  canRecordBills,
  canRecordPayments,
}: {
  view: View;
  canRecordBills: boolean;
  canRecordPayments: boolean;
}) {
  const current = VIEWS.find((item) => item.value === view) ?? VIEWS[0]!;
  const action =
    view === "bills"
      ? canRecordBills && { href: "/payments/bills/new", label: "Record bill" }
      : view === "payments"
        ? canRecordPayments && {
            href: "/payments/supplier/new",
            label: "Record payment",
          }
        : canRecordPayments && {
            href: "/payments/receipts/new",
            label: "Record receipt",
          };
  return (
    <>
      <PageHeader
        title="Payments"
        description="Bills you owe, and the money paid out and received against them."
        breadcrumbs={[
          { label: "JobFlow", href: "/home" },
          { label: "Payments" },
        ]}
        actions={
          action ? (
            <Button asChild>
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ) : null
        }
      />
      <nav aria-label="Payments sections">
        <ul className="flex flex-wrap gap-2">
          {VIEWS.map((item) => (
            <li key={item.value}>
              <Link
                href={`/payments?view=${item.value}`}
                aria-current={item.value === current.value ? "page" : undefined}
                className="inline-flex min-h-11 items-center rounded-sm border px-4 aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section aria-labelledby="payments-view" className="space-y-4">
        <div>
          <h2 id="payments-view" className="text-xl font-semibold">
            {current.label}
          </h2>
          <p className="text-muted-foreground">{current.description}</p>
        </div>
        {current.value === "bills" ? (
          <Bills canDecide={canRecordBills} />
        ) : current.value === "payments" ? (
          <Payments />
        ) : (
          <Receipts />
        )}
      </section>
    </>
  );
}
