"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { TextField, Field } from "@/components/form/field";
import { useRemote } from "@/components/data/use-remote";
import { EmployeeEditor } from "./editor";
import type { Employee } from "./types";

export function EmployeeDirectory({ editable }: { editable: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false),
    [q, setQ] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("active"),
    [page, setPage] = useState(1);
  const { data, error, reload } = useRemote<{
    employees: Employee[];
    total: number;
    pageSize: number;
  }>(
    `/api/employees?${new URLSearchParams({ q: search, status, page: String(page), pageSize: "20" })}`,
  );
  return (
    <>
      <PageHeader
        title="Employees"
        description="Staff records, linked logins and internal cost rates. No payroll."
        actions={
          editable && !creating ? (
            <Button onClick={() => setCreating(true)}>Add employee</Button>
          ) : null
        }
      />
      {creating ? (
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">Add employee</h2>
          <EmployeeEditor
            saved={(row) => router.push(`/employees/${row.id}`)}
            cancel={() => setCreating(false)}
          />
        </section>
      ) : null}
      <form
        className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(q);
          setPage(1);
        }}
      >
        <TextField
          id="employee-search"
          label="Search employees"
          maxLength={100}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name or email"
        />
        <Field id="employee-status" label="Status">
          {(control) => (
            <select
              {...control}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All employees</option>
            </select>
          )}
        </Field>
        <Button type="submit">Search</Button>
      </form>
      {error ? (
        <div role="alert" className="rounded-lg border p-4">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {!data && !error ? (
        <p role="status">Loading employees…</p>
      ) : data ? (
        <>
          <p className="text-sm text-muted-foreground">
            {data.total} employees · Page {page} of{" "}
            {Math.max(1, Math.ceil(data.total / data.pageSize))} · Name A–Z
          </p>
          {data.employees.length ? (
            <ul className="grid gap-4 lg:grid-cols-2">
              {data.employees.map((row) => (
                <li
                  key={row.id}
                  className="min-w-0 space-y-2 rounded-lg border bg-card p-4 [overflow-wrap:anywhere]"
                >
                  <Link
                    className="inline-flex min-h-11 items-center font-semibold underline"
                    href={`/employees/${row.id}`}
                  >
                    {row.name}
                  </Link>
                  <p>
                    {row.isActive ? "Active" : "Inactive"} ·{" "}
                    {row.userId ? "Login linked" : "No login"}
                  </p>
                  <p>
                    {row.email ?? "No email"} · {row.phone ?? "No phone"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <section className="rounded-lg border bg-card p-6">
              <h2 className="text-xl font-semibold">No matching employees</h2>
              <p>Try another search or status filter.</p>
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
