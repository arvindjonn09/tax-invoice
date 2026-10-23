"use client";
import { useState } from "react";
import { Field, TextField } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/data/use-remote";
export function EntityPicker({
  kind,
  id,
  label,
  value,
  onChange,
  error,
}: {
  kind: "customers" | "employees";
  id: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  error?: string | undefined;
}) {
  const [selectedName, setSelectedName] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const {
    data,
    error: failure,
    reload,
  } = useRemote<{
    total: number;
    pageSize: number;
    customers?: { id: string; name: string }[];
    employees?: { id: string; name: string }[];
  }>(
    `/api/${kind}?${new URLSearchParams({ q, page: String(page), pageSize: "20", status: "active" })}`,
  );
  const rows = data?.[kind] ?? [];
  const singular = kind === "customers" ? "customer" : "employee";
  return (
    <div className="space-y-3">
      <div data-filter="true">
        <TextField
          id={`${id}-search`}
          label={`Find ${singular}`}
          hint="Search active records by name or email. Results update as you type."
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
      </div>
      <Field id={id} label={label} error={error}>
        {(control) => (
          <select
            {...control}
            required
            value={value}
            onChange={(event) => {
              setSelectedName(
                rows.find((row) => row.id === event.target.value)?.name ?? "",
              );
              onChange(event.target.value);
            }}
          >
            <option value="">Choose {singular}</option>
            {value && !rows.some((row) => row.id === value) ? (
              <option value={value}>
                {selectedName || `Selected ${singular}`}
              </option>
            ) : null}
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      {failure ? (
        <div role="alert">
          <p>{failure}</p>
          <Button type="button" variant="outline" onClick={reload}>
            Retry {singular} search
          </Button>
        </div>
      ) : !data ? (
        <p role="status">Loading {kind}…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {data.total} active {kind} · page {page} of{" "}
            {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}
            aria-label={`Previous ${kind}`}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={page * data.pageSize >= data.total}
            onClick={() => setPage((value) => value + 1)}
            aria-label={`Next ${kind}`}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
