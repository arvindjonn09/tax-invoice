"use client";
import Link from "next/link";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { PageHeader } from "@/components/shell/page-header";
import { Field, TextField } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { day, statusLabel } from "@/features/jobs/types";
import { StatusPill } from "@/components/status-pill";
import type { OwnOffer } from "./types";
/** Job statuses where accepted work is over, so it isn't read as actionable. */
const FINISHED: Record<string, string | undefined> = {
  cancelled: "Job cancelled",
  invoiced: "Job invoiced",
  closed: "Job closed",
};
export function PortalDirectory({ jobsOnly }: { jobsOnly: boolean }) {
  const [q, setQ] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1);
  const { data, error, reload } = useRemote<{
    offers: OwnOffer[];
    total: number;
    pageSize: number;
  }>(
    `/api/my/offers?${new URLSearchParams({ q: search, status, page: String(page), pageSize: "20", view: jobsOnly ? "jobs" : "offers" })}`,
  );
  return (
    <>
      <PageHeader
        title={jobsOnly ? "My jobs" : "My offers"}
        description={
          jobsOnly
            ? "Your accepted work and completion evidence."
            : "Work offered to you, your agreed terms and response history."
        }
      />
      <form
        className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
          setPage(1);
        }}
      >
        <TextField
          id="own-search"
          label={jobsOnly ? "Search my jobs" : "Search my offers"}
          maxLength={100}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Job reference, title or work scope"
        />
        {!jobsOnly ? (
          <Field id="own-status" label="Offer status">
            {(control) => (
              <select
                {...control}
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All offers</option>
                {["offered", "accepted", "declined", "withdrawn"].map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Button type="submit">Search</Button>
      </form>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {!data && !error ? (
        <p role="status">Loading your {jobsOnly ? "jobs" : "offers"}…</p>
      ) : data ? (
        <>
          <p className="text-sm text-muted-foreground">
            {data.total} {jobsOnly ? "accepted jobs" : "offers"} · Page {page}{" "}
            of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          {data.offers.length ? (
            <ul className="grid gap-4 lg:grid-cols-2">
              {data.offers.map((offer) => (
                <li
                  key={offer.id}
                  className="min-w-0 space-y-2 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]"
                >
                  <h2 className="text-lg font-semibold">
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      href={`/offers/${offer.id}`}
                    >
                      {offer.job.reference} · {offer.job.title}
                    </Link>
                  </h2>
                  <p>
                    Offer: {statusLabel(offer.status)} · Job:{" "}
                    {statusLabel(offer.job.status)}
                  </p>
                  {offer.status === "accepted" && FINISHED[offer.job.status] ? (
                    <p>
                      <StatusPill
                        status={
                          offer.job.status === "cancelled"
                            ? "void"
                            : "completed"
                        }
                        label={FINISHED[offer.job.status]!}
                      />{" "}
                      No further work is needed on this job.
                    </p>
                  ) : null}
                  <p>Due {day(offer.job.dueOn)}</p>
                  <p className="whitespace-pre-wrap">{offer.scope}</p>
                </li>
              ))}
            </ul>
          ) : (
            <section className="rounded-lg border bg-card p-6">
              <h2 className="text-xl font-semibold">
                {jobsOnly ? "No accepted jobs" : "No matching offers"}
              </h2>
              <p>
                {jobsOnly
                  ? "Accepted work appears here. Open My offers to respond to new work."
                  : "Try another search or status. If you expected work here, ask the office to check your contractor login link."}
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
