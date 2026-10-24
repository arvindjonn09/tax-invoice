"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/form/field";
import { useRemote } from "@/components/data/use-remote";
import { MoneyDisplay } from "@/components/money-display";
import { day } from "@/features/jobs/types";
import type { Invoice } from "./types";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft · not issued",
  issued: "Issued",
  void: "Void",
};

export function InvoiceList({
  canWrite,
  today,
}: {
  canWrite: boolean;
  today: string;
}) {
  const [status, setStatus] = useState(""),
    [kind, setKind] = useState(""),
    [pastDue, setPastDue] = useState(false),
    [page, setPage] = useState(1);
  const { data, error, reload } = useRemote<{
    invoices: Invoice[];
    total: number;
    pageSize: number;
  }>(
    `/api/invoices?${new URLSearchParams({
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      page: String(page),
      pageSize: "50",
    })}`,
  );
  const customers = useRemote<{ customers: { id: string; name: string }[] }>(
    "/api/customers?status=all&pageSize=100",
  );
  const names = new Map(customers.data?.customers.map((c) => [c.id, c.name]));
  const rows =
    data?.invoices.filter(
      (row) =>
        !pastDue ||
        (row.status === "issued" &&
          row.kind === "invoice" &&
          row.dueOn !== null &&
          row.dueOn < today),
    ) ?? [];
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Tax invoices, invoices and credit notes. Issued documents are read only."
        actions={
          canWrite ? (
            <Button asChild>
              <Link href="/invoices/new">New invoice</Link>
            </Button>
          ) : null
        }
      />
      <div className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <Field id="invoice-status" label="Status">
          {(control) => (
            <select
              {...control}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="draft">Drafts</option>
              <option value="issued">Issued</option>
              <option value="void">Void</option>
            </select>
          )}
        </Field>
        <Field id="invoice-kind" label="Type">
          {(control) => (
            <select
              {...control}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Invoices and credit notes</option>
              <option value="invoice">Invoices</option>
              <option value="credit_note">Credit notes</option>
            </select>
          )}
        </Field>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={pastDue}
            onChange={(event) => setPastDue(event.target.checked)}
          />
          Past due date only (on this page)
        </label>
      </div>
      {error ? (
        <div role="alert" className="rounded-lg border p-4">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {!data && !error ? (
        <p role="status">Loading invoices…</p>
      ) : data ? (
        <>
          <p className="text-sm text-muted-foreground">
            {data.total} documents · Page {page} of{" "}
            {Math.max(1, Math.ceil(data.total / data.pageSize))} · Newest first
          </p>
          {rows.length ? (
            <ul className="grid gap-4 lg:grid-cols-2">
              {rows.map((row) => {
                const due =
                  row.status === "issued" &&
                  row.kind === "invoice" &&
                  row.dueOn &&
                  row.dueOn < today;
                return (
                  <li
                    key={row.id}
                    className="min-w-0 space-y-2 rounded-lg border bg-card p-4 [overflow-wrap:anywhere]"
                  >
                    <Link
                      className="inline-flex min-h-11 items-center font-semibold underline"
                      href={`/invoices/${row.id}`}
                    >
                      {row.reference
                        ? `${row.title} ${row.reference}`
                        : row.kind === "credit_note"
                          ? "Draft credit note"
                          : "Draft invoice"}
                    </Link>
                    <p>
                      {STATUS_LABEL[row.status]}
                      {due ? ` · Past due date (${day(row.dueOn)})` : ""}
                    </p>
                    <p>
                      {row.customer?.name ??
                        names.get(row.customerId) ??
                        "Customer"}
                    </p>
                    <p>
                      {row.status === "draft" ? (
                        "Total confirmed when saved"
                      ) : (
                        <MoneyDisplay
                          cents={BigInt(row.inclusiveCents)}
                          basis="incl GST"
                        />
                      )}
                      {row.issueDate ? ` · ${day(row.issueDate)}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <section className="rounded-lg border bg-card p-6">
              <h2 className="text-xl font-semibold">No matching invoices</h2>
              <p>
                {canWrite
                  ? "Create a new invoice, or change the filters."
                  : "Change the filters."}
              </p>
            </section>
          )}
          <div className="flex gap-3">
            <Button
              variant="outline"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page * data.pageSize >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}
