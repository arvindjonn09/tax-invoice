"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Field } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/money-display";
import { useRemote } from "@/components/data/use-remote";
import { type Quote, STATE_LABEL, percent } from "./types";

const STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "superseded",
] as const;

/** Quotes and variations, newest first. Margins are internal and ex GST. */
export function QuotesList({ editable }: { editable: boolean }) {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({
    ...(status ? { status } : {}),
    page: String(page),
    pageSize: "20",
  });
  const { data, error, reload } = useRemote<{
    quotes: Quote[];
    total: number;
    pageSize: number;
  }>(`/api/quotes?${params}`);
  const kind = (quote: Quote) =>
    quote.kind === "variation" ? "Variation" : "Quote";
  return (
    <>
      <PageHeader
        title="Quotes"
        description="Price work, send it, and turn accepted quotes into jobs."
        breadcrumbs={[{ label: "JobFlow", href: "/home" }, { label: "Quotes" }]}
        actions={
          editable ? (
            <Button asChild>
              <Link href="/quotes/new">New quote</Link>
            </Button>
          ) : null
        }
      />
      <div className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <Field id="quote-status-filter" label="Status">
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
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATE_LABEL[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {error ? (
        <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
          <p>{error}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : !data ? (
        <p role="status">Loading quotes…</p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {data.total} {data.total === 1 ? "quote" : "quotes"} · Page {page}{" "}
            of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          {!data.quotes.length ? (
            <section className="space-y-2 rounded-lg border bg-card p-8">
              <h2 className="text-xl font-semibold">
                {status ? "No matching quotes" : "No quotes yet"}
              </h2>
              <p className="text-muted-foreground">
                {status
                  ? "Try another status."
                  : editable
                    ? "Create a quote to price work for a customer."
                    : "Quotes will appear here when your team creates them."}
              </p>
            </section>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                <table className="w-full min-w-[760px] table-fixed text-left">
                  <caption className="sr-only">Quotes and variations</caption>
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[20%]" />
                    <col className="w-[22%]" />
                    <col className="w-[18%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b bg-muted">
                      <th className="p-4">Quote</th>
                      <th className="p-4">Status</th>
                      <th className="p-4">Total (incl GST)</th>
                      <th className="p-4">Est. margin (ex GST)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.quotes.map((quote) => (
                      <tr key={quote.id} className="border-b last:border-0">
                        <td className="p-4">
                          <Link
                            className="inline-flex min-h-11 max-w-full items-center font-semibold underline [overflow-wrap:anywhere]"
                            href={`/quotes/${quote.id}`}
                          >
                            {kind(quote)} {quote.reference} · {quote.title}
                          </Link>
                        </td>
                        <td className="p-4">{STATE_LABEL[quote.state]}</td>
                        <td className="p-4">
                          <MoneyDisplay
                            cents={BigInt(quote.inclusiveCents)}
                            basis="incl GST"
                          />
                        </td>
                        <td className="p-4 tabular-nums">
                          {percent(quote.estimate.marginBasisPoints)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="space-y-3 md:hidden">
                {data.quotes.map((quote) => (
                  <li
                    key={quote.id}
                    className="space-y-2 rounded-lg border bg-card p-4"
                  >
                    <Link
                      className="inline-flex min-h-11 max-w-full items-center font-semibold underline [overflow-wrap:anywhere]"
                      href={`/quotes/${quote.id}`}
                    >
                      {kind(quote)} {quote.reference} · {quote.title}
                    </Link>
                    <p>{STATE_LABEL[quote.state]}</p>
                    <MoneyDisplay
                      cents={BigInt(quote.inclusiveCents)}
                      basis="incl GST"
                    />
                    <p className="text-sm tabular-nums">
                      Est. margin {percent(quote.estimate.marginBasisPoints)}{" "}
                      (ex GST)
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          <nav aria-label="Quote pages" className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page * data.pageSize >= data.total}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </nav>
        </>
      )}
    </>
  );
}
