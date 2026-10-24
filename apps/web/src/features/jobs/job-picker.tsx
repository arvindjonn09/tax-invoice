"use client";
import { useState } from "react";
import { Field, TextField } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/data/use-remote";

type JobRow = { id: string; reference: string; title: string };

/**
 * Searchable, paged job choice. The customer filter is applied by the
 * server before paging, so an older job is always reachable.
 */
export function JobPicker({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  customerId,
  emptyLabel,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (id: string) => void;
  error?: string | undefined;
  customerId?: string;
  emptyLabel: string;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const params = new URLSearchParams({ q, page: String(page), pageSize: "20" });
  if (customerId) params.set("customerId", customerId);
  const {
    data,
    error: failure,
    reload,
  } = useRemote<{
    total: number;
    pageSize: number;
    jobs: JobRow[];
  }>(disabled ? null : `/api/jobs?${params}`);
  const rows = data?.jobs ?? [];
  const name = (job: JobRow) => `${job.reference} · ${job.title}`;
  return (
    <div className="space-y-3">
      <TextField
        id={`${id}-search`}
        label="Find job"
        hint="Search by job reference or title."
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
        maxLength={100}
        value={q}
        onChange={(event) => {
          setQ(event.target.value);
          setPage(1);
        }}
      />
      <Field id={id} label={label} error={error} {...(hint ? { hint } : {})}>
        {(control) => (
          <select
            {...control}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              const row = rows.find((job) => job.id === event.target.value);
              setSelected(row ? name(row) : "");
              onChange(event.target.value);
            }}
          >
            <option value="">{emptyLabel}</option>
            {value && !rows.some((job) => job.id === value) ? (
              <option value={value}>{selected || "Selected job"}</option>
            ) : null}
            {rows.map((job) => (
              <option key={job.id} value={job.id}>
                {name(job)}
              </option>
            ))}
          </select>
        )}
      </Field>
      {disabled ? null : failure ? (
        <div role="alert">
          <p>{failure}</p>
          <Button type="button" variant="outline" onClick={reload}>
            Retry job search
          </Button>
        </div>
      ) : !data ? (
        <p role="status">Loading jobs…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {data.total} matching {data.total === 1 ? "job" : "jobs"} · page{" "}
            {page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage((current) => current - 1)}
            aria-label="Previous jobs"
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={page * data.pageSize >= data.total}
            onClick={() => setPage((current) => current + 1)}
            aria-label="Next jobs"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
