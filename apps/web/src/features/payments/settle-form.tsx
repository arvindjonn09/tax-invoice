"use client";
import { useRouter } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import {
  Field,
  FormMessage,
  TextField,
  sendJson,
} from "@/components/form/field";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { formatAudCents } from "@/components/money-display";
import { EntityPicker } from "@/features/jobs/picker";
import {
  type Allocation,
  AllocationTable,
  type Target,
  allocationTotal,
  chosen,
} from "./allocations";
import {
  type Bill,
  METHODS,
  type Method,
  type OpenInvoice,
  idempotencyKey,
} from "./types";
import { useAllPages } from "./use-all-pages";

type Common = {
  date: string;
  method: Method;
  reference: string;
};

/**
 * Shared shell for recording money that moved: date, method, reference and
 * allocations. The amount is the sum of the allocations, so a settlement
 * always settles exactly what it says. One idempotency key is kept per
 * attempt, so a retry after a network failure can’t record it twice.
 */
function SettleForm({
  title,
  description,
  back,
  dateLabel,
  today,
  targets,
  loading,
  loadFailure,
  legend,
  emptyText,
  before,
  submitLabel,
  url,
  payload,
  onRecorded,
  state,
  setState,
}: {
  title: string;
  description: string;
  back: { label: string; href: string };
  dateLabel: string;
  today: string;
  targets: readonly Target[];
  loading: boolean;
  /** Why the bills or invoices couldn't be loaded, with a retry. */
  loadFailure: { message: string; retry: () => void } | null;
  legend: string;
  emptyText: string;
  before?: ReactNode;
  submitLabel: string;
  url: string;
  payload: (
    common: Common,
    allocations: { id: string; amountCents: string }[],
    amountCents: string,
  ) => unknown;
  onRecorded: (id: string) => void;
  state: Record<string, Allocation>;
  setState: (
    next: (current: Record<string, Allocation>) => Record<string, Allocation>,
  ) => void;
}) {
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<Method>("bank_transfer");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [targetErrors, setTargetErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const key = useRef(idempotencyKey());
  const summary = useRef<HTMLHeadingElement>(null);
  useUnsavedChanges(dirty);
  const total = allocationTotal(targets, state);
  const touch = () => {
    setDirty(true);
    setMessage(null);
    setErrors({});
    setTargetErrors({});
    // A changed request is a new attempt; an unchanged retry keeps the key.
    key.current = idempotencyKey();
  };

  const fail = (
    fields: Record<string, string>,
    byTarget: Record<string, string>,
    text: string,
  ) => {
    setErrors(fields);
    setTargetErrors(byTarget);
    setMessage({ kind: "error", text });
    requestAnimationFrame(() => summary.current?.focus());
  };

  async function submit() {
    const picked = chosen(targets, state);
    if (!picked.ids.length)
      return fail(
        { allocations: "Tick at least one to settle." },
        {},
        "Fix the highlighted fields.",
      );
    if (total === null) {
      const bad: Record<string, string> = {};
      for (const id of picked.ids)
        if (
          allocationTotal(
            targets.filter((t) => t.id === id),
            state,
          ) === null
        )
          bad[id] = "Enter an amount above $0 with at most two decimal places.";
      return fail({}, bad, "Fix the highlighted fields.");
    }
    setBusy(true);
    const result = await sendJson(
      url,
      "POST",
      payload(
        { date, method, reference: reference.trim() },
        picked.ids.map((id, index) => ({
          id,
          amountCents: picked.amounts[index]!.toString(),
        })),
        total.toString(),
      ),
      { "idempotency-key": key.current },
    );
    setBusy(false);
    if (!result.ok) {
      const { byTarget, rest } = picked.remap(result.fields);
      return fail(rest, byTarget, result.message);
    }
    setDirty(false);
    onRecorded((result.body as { id: string }).id);
  }

  const all = { ...errors, ...targetErrors };
  const errorList = Object.entries(all);
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={[back, { label: title }]}
      />
      <div aria-live="polite">
        <section
          className={
            errorList.length
              ? "rounded-lg border border-danger-foreground p-4"
              : "sr-only"
          }
        >
          <h2 ref={summary} tabIndex={-1} className="font-semibold">
            {errorList.length
              ? `Fix ${errorList.length} ${errorList.length === 1 ? "problem" : "problems"}`
              : "No problems"}
          </h2>
          {errorList.length ? (
            <ul className="list-disc pl-6">
              {errorList.map(([field, text]) => (
                <li key={field}>{text}</li>
              ))}
            </ul>
          ) : null}
        </section>
        <FormMessage message={message} />
      </div>
      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <fieldset
          disabled={busy}
          className="space-y-4 rounded-lg border bg-card p-6"
        >
          <legend className="text-xl font-semibold">Settles</legend>
          {before}
          {loadFailure ? (
            <div role="alert" className="space-y-2">
              <p>{loadFailure.message}</p>
              <Button
                type="button"
                variant="outline"
                onClick={loadFailure.retry}
              >
                Try again
              </Button>
            </div>
          ) : loading ? (
            <p role="status">Loading what’s owing…</p>
          ) : targets.length ? (
            <AllocationTable
              legend={legend}
              targets={targets}
              state={state}
              errors={targetErrors}
              onChange={(id, next) => {
                setState((current) => ({ ...current, [id]: next }));
                touch();
              }}
            />
          ) : (
            <p>{emptyText}</p>
          )}
          {errors.allocations ? (
            <p className="text-sm text-danger-foreground">
              {errors.allocations}
            </p>
          ) : null}
          <p className="text-lg font-semibold tabular-nums" aria-live="polite">
            Amount: {total === null ? "—" : `${formatAudCents(total)} AUD`}
          </p>
        </fieldset>
        <fieldset
          disabled={busy}
          className="grid gap-4 rounded-lg border bg-card p-6 md:grid-cols-3"
        >
          <legend className="text-xl font-semibold">Payment details</legend>
          <TextField
            id="settle-date"
            label={dateLabel}
            type="date"
            max={today}
            value={date}
            error={errors.paidOn ?? errors.receivedOn}
            onChange={(event) => {
              setDate(event.target.value);
              touch();
            }}
          />
          <Field
            id="settle-method"
            label="Method (required)"
            error={errors.method}
          >
            {(control) => (
              <select
                {...control}
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value as Method);
                  touch();
                }}
              >
                {METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <TextField
            id="settle-reference"
            label="Reference"
            hint="Bank or cheque reference."
            maxLength={100}
            value={reference}
            error={errors.reference}
            onChange={(event) => {
              setReference(event.target.value);
              touch();
            }}
          />
        </fieldset>
        <Button type="submit" disabled={busy || !targets.length}>
          {busy ? "Recording…" : submitLabel}
        </Button>
      </form>
    </>
  );
}

const payeeOf = (bill: Bill) =>
  bill.contractorId
    ? `c:${bill.contractorId}`
    : `s:${bill.supplierName}|${bill.supplierAbn ?? ""}`;

/** Pay one supplier: allocate across their owing bills. */
export function SupplierPaymentForm({
  today,
  billId,
}: {
  today: string;
  billId: string | null;
}) {
  const router = useRouter();
  const bills = useAllPages<Bill>("/api/bills?status=owing", "bills");
  const owing = (bills.rows ?? []).filter(
    (bill) => BigInt(bill.outstandingCents) > 0n,
  );
  const preset = owing.find((bill) => bill.id === billId);
  const [payee, setPayee] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, Allocation>>({});
  const current = payee ?? (preset ? payeeOf(preset) : "");
  const payees = [
    ...new Map(
      owing.map((bill) => [payeeOf(bill), bill.supplierName]),
    ).entries(),
  ];
  const targets: Target[] = owing
    .filter((bill) => payeeOf(bill) === current)
    .map((bill) => ({
      id: bill.id,
      label: bill.supplierReference
        ? `Bill ${bill.supplierReference}`
        : `Bill of ${bill.issuedOn}`,
      detail: `Dated ${bill.issuedOn}${bill.dueOn ? `, due ${bill.dueOn}` : ""}`,
      limitCents: bill.outstandingCents,
      limitLabel: "owing",
    }));
  const allocations =
    preset && payee === null && !Object.keys(state).length
      ? {
          [preset.id]: {
            selected: true,
            amount: `${BigInt(preset.outstandingCents) / 100n}.${(BigInt(preset.outstandingCents) % 100n).toString().padStart(2, "0")}`,
          },
        }
      : state;
  return (
    <SettleForm
      title="Record payment"
      description="Money paid to a supplier or contractor. It settles bills; it isn't a cost itself."
      back={{ label: "Payments", href: "/payments?view=payments" }}
      dateLabel="Paid on (required)"
      today={today}
      loading={!bills.rows}
      loadFailure={
        bills.error ? { message: bills.error, retry: bills.reload } : null
      }
      targets={targets}
      legend="Bills to pay"
      emptyText={
        current ? "This supplier has no bills owing." : "Choose who you paid."
      }
      before={
        <>
          {bills.truncated ? (
            <p
              role="status"
              className="rounded-sm bg-warning p-3 text-warning-foreground"
            >
              Showing the newest 5,000 owing bills only.
            </p>
          ) : null}
          {billId && bills.rows && !preset ? (
            <p
              role="status"
              className="rounded-sm bg-warning p-3 text-warning-foreground"
            >
              That bill has nothing owing (it’s paid or void).
            </p>
          ) : null}
          <Field id="settle-payee" label="Paid to (required)">
            {(control) => (
              <select
                {...control}
                value={current}
                onChange={(event) => {
                  setPayee(event.target.value);
                  setState({});
                }}
              >
                <option value="">Choose a supplier with bills owing</option>
                {payees.map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      }
      submitLabel="Record payment"
      url="/api/supplier-payments"
      payload={(common, picked, amountCents) => ({
        paidOn: common.date,
        method: common.method,
        ...(common.reference ? { reference: common.reference } : {}),
        amountCents,
        allocations: picked.map((a) => ({
          billId: a.id,
          amountCents: a.amountCents,
        })),
      })}
      onRecorded={(id) => router.push(`/payments/supplier/${id}?recorded=1`)}
      state={allocations}
      setState={(next) => setState(next(allocations))}
    />
  );
}

/** Record money received from (or refunded to) a customer against invoices. */
export function ReceiptForm({ today }: { today: string }) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [kind, setKind] = useState<"receipt" | "refund">("receipt");
  const [state, setState] = useState<Record<string, Allocation>>({});
  const invoices = useAllPages<OpenInvoice>(
    customerId
      ? `/api/invoices?${new URLSearchParams({ customerId, status: "issued", kind: "invoice" })}`
      : null,
    "invoices",
  );
  const targets: Target[] = (invoices.rows ?? [])
    .map((invoice) => ({
      invoice,
      limit: BigInt(
        (kind === "refund"
          ? invoice.receivedCents
          : invoice.outstandingCents) ?? "0",
      ),
    }))
    .filter(({ limit }) => limit > 0n)
    .map(({ invoice, limit }) => ({
      id: invoice.id,
      label: `Invoice ${invoice.reference ?? ""}`.trim(),
      detail: `Issued ${invoice.issueDate ?? ""}, ${formatAudCents(BigInt(invoice.inclusiveCents))} AUD incl GST`,
      limitCents: limit.toString(),
      limitLabel: kind === "refund" ? "received so far" : "owing",
    }));
  return (
    <SettleForm
      title={kind === "refund" ? "Record refund" : "Record receipt"}
      description={
        kind === "refund"
          ? "Money returned to a customer against invoices they paid."
          : "Money received from a customer. It settles invoices; GST is attributed on receipt for cash-basis BAS."
      }
      back={{ label: "Payments", href: "/payments?view=receipts" }}
      dateLabel={
        kind === "refund" ? "Refunded on (required)" : "Received on (required)"
      }
      today={today}
      loading={Boolean(customerId) && !invoices.rows}
      loadFailure={
        invoices.error
          ? { message: invoices.error, retry: invoices.reload }
          : null
      }
      targets={targets}
      legend={kind === "refund" ? "Invoices to refund" : "Invoices paid"}
      emptyText={
        !customerId
          ? "Choose the customer first."
          : kind === "refund"
            ? "Nothing has been received on this customer's invoices."
            : "This customer has no invoices owing."
      }
      before={
        <div className="space-y-4">
          <EntityPicker
            kind="customers"
            id="receipt-customer"
            label="Customer (required)"
            value={customerId}
            onChange={(id) => {
              setCustomerId(id);
              setState({});
            }}
          />
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-2 font-medium">Type</legend>
            {(
              [
                ["receipt", "Money received"],
                ["refund", "Refund paid out"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="receipt-kind"
                  checked={kind === value}
                  onChange={() => {
                    setKind(value);
                    setState({});
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </div>
      }
      submitLabel={kind === "refund" ? "Record refund" : "Record receipt"}
      url="/api/receipts"
      payload={(common, picked, amountCents) => ({
        customerId,
        kind,
        receivedOn: common.date,
        method: common.method,
        ...(common.reference ? { reference: common.reference } : {}),
        amountCents,
        allocations: picked.map((a) => ({
          invoiceId: a.id,
          amountCents: a.amountCents,
        })),
      })}
      onRecorded={(id) => router.push(`/payments/receipts/${id}?recorded=1`)}
      state={state}
      setState={(next) => setState(next)}
    />
  );
}
