"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { JOB_STATUSES } from "@jobflow/domain";
import { PageHeader } from "@/components/shell/page-header";
import { Field, TextField } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/money-display";
import { useRemote } from "@/components/data/use-remote";
import { JobEditor } from "./editor";
import { day, statusLabel, type Job } from "./types";
export function JobsDirectory({
  office,
  editable,
}: {
  office: boolean;
  editable: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("number:desc");
  const [page, setPage] = useState(1);
  const [field = "number", direction = "desc"] = sort.split(":");
  const params = new URLSearchParams({
    q,
    status,
    sort: field,
    direction,
    page: String(page),
    pageSize: "20",
  });
  const { data, error, reload } = useRemote<{
    jobs: Job[];
    total: number;
    pageSize: number;
  }>(`${office ? "/api/jobs" : "/api/my/jobs"}?${params}`);
  return (
    <>
      <PageHeader
        title={office ? "Jobs" : "My jobs"}
        description={
          office
            ? "Plan work, organise visits and keep the team assigned."
            : "Your current employee assignments. Times are shown in your browser's local timezone."
        }
        actions={
          editable && !creating ? (
            <Button onClick={() => setCreating(true)}>Create job</Button>
          ) : null
        }
      />
      {creating ? (
        <section className="space-y-4 rounded-lg border bg-card p-6">
          <h2 className="text-xl font-semibold">Create job</h2>
          <JobEditor
            onCancel={() => setCreating(false)}
            onSaved={(job) => router.push(`/jobs/${job.id}`)}
          />
        </section>
      ) : null}
      <form
        className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(draft);
          setPage(1);
        }}
      >
        <TextField
          id="job-search"
          label="Search jobs"
          placeholder="Reference or title"
          value={draft}
          maxLength={100}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Field id="job-status-filter" label="Status">
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
              {JOB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="job-sort" label="Sort by">
          {(control) => (
            <select
              {...control}
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
            >
              <option value="number:desc">Newest job first</option>
              <option value="number:asc">Oldest job first</option>
              <option value="title:asc">Title A–Z</option>
              <option value="dueOn:asc">Due date</option>
              <option value="status:asc">Status</option>
            </select>
          )}
        </Field>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {error ? (
        <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
          <p>{error}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : !data ? (
        <p role="status">Loading jobs…</p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {data.total} {data.total === 1 ? "job" : "jobs"} · Page {page} of{" "}
            {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          {!data.jobs.length ? (
            <section className="space-y-2 rounded-lg border bg-card p-8">
              <h2 className="text-xl font-semibold">
                {q || status ? "No matching jobs" : "No jobs to show"}
              </h2>
              <p className="text-muted-foreground">
                {q || status
                  ? "Try another search or status filter."
                  : editable
                    ? "Create a job to plan visits and assign your team."
                    : office
                      ? "Jobs will appear here when your team creates them."
                      : "Jobs will appear here when your team assigns work."}
              </p>
            </section>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                <table className="w-full min-w-[720px] table-fixed text-left">
                  <caption className="sr-only">
                    {office ? "Jobs directory" : "Assigned jobs"}
                  </caption>
                  <colgroup>
                    <col className={office ? "w-[46%]" : "w-[60%]"} />
                    <col className="w-[18%]" />
                    <col className="w-[18%]" />
                    {office ? <col className="w-[18%]" /> : null}
                  </colgroup>
                  <thead>
                    <tr className="border-b bg-muted">
                      <th className="p-4">Job</th>
                      <th className="p-4">Status</th>
                      <th className="p-4">Due date</th>
                      {office ? (
                        <th className="p-4">Agreed price (ex GST)</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobs.map((job) => (
                      <tr key={job.id} className="border-b last:border-0">
                        <td className="p-4">
                          <Link
                            className="inline-flex min-h-11 max-w-full items-center font-semibold underline [overflow-wrap:anywhere]"
                            href={`/jobs/${job.id}`}
                          >
                            {job.reference} · {job.title}
                          </Link>
                        </td>
                        <td className="p-4">{statusLabel(job.status)}</td>
                        <td className="p-4">{day(job.dueOn)}</td>
                        {office ? (
                          <td className="p-4">
                            {job.agreedPriceExclusiveCents == null ? (
                              "Not provided"
                            ) : (
                              <MoneyDisplay
                                cents={BigInt(job.agreedPriceExclusiveCents)}
                                basis="ex GST"
                              />
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="space-y-3 md:hidden">
                {data.jobs.map((job) => (
                  <li
                    key={job.id}
                    className="space-y-2 rounded-lg border bg-card p-4"
                  >
                    <Link
                      className="inline-flex min-h-11 max-w-full items-center font-semibold underline [overflow-wrap:anywhere]"
                      href={`/jobs/${job.id}`}
                    >
                      {job.reference} · {job.title}
                    </Link>
                    <p>
                      {statusLabel(job.status)} · Due {day(job.dueOn)}
                    </p>
                    {job.customerName ? <p>{job.customerName}</p> : null}
                    {office && job.agreedPriceExclusiveCents != null ? (
                      <MoneyDisplay
                        cents={BigInt(job.agreedPriceExclusiveCents)}
                        basis="ex GST"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
          <nav aria-label="Job pages" className="flex flex-wrap gap-3">
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
