"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { FormMessage, sendJson } from "@/components/form/field";
import { useRemote } from "@/components/data/use-remote";
import { EmployeeEditor } from "./editor";
import { RateHistory } from "./rates";
import type { Employee } from "./types";

export function EmployeeDetail({
  id,
  editable,
  canReadRates,
  today,
}: {
  id: string;
  editable: boolean;
  canReadRates: boolean;
  today: string;
}) {
  const { data, error, reload } = useRemote<Employee>(`/api/employees/${id}`);
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  if (!data)
    return error ? (
      <div role="alert">
        <p>{error}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    ) : (
      <p role="status">Loading employee…</p>
    );
  return (
    <>
      <PageHeader
        title={data.name}
        description={data.isActive ? "Active employee" : "Inactive employee"}
        breadcrumbs={[
          { label: "Employees", href: "/employees" },
          { label: data.name },
        ]}
      />
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      <FormMessage message={message} />
      <section className="min-w-0 space-y-4 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]">
        <h2 className="text-xl font-semibold">Employee details</h2>
        {editing ? (
          <EmployeeEditor
            initial={data}
            saved={() => {
              setEditing(false);
              setMessage({ kind: "success", text: "Employee saved." });
              reload();
            }}
            cancel={() => setEditing(false)}
          />
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Email</dt>
                <dd>{data.email ?? "Not provided"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Phone</dt>
                <dd>{data.phone ?? "Not provided"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Login</dt>
                <dd>
                  {data.userId
                    ? "Linked — can log own time and expenses"
                    : "Not linked"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{data.isActive ? "Active" : "Inactive"}</dd>
              </div>
            </dl>
            {editable ? (
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => setEditing(true)}>
                  Edit employee
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        data.isActive
                          ? "Deactivate this employee? Their records, timesheets and cost-rate history remain."
                          : "Reactivate this employee?",
                      )
                    )
                      return;
                    setBusy(true);
                    const result = await sendJson(
                      `/api/employees/${id}`,
                      "PATCH",
                      { isActive: !data.isActive },
                    );
                    setBusy(false);
                    if (!result.ok)
                      setMessage({ kind: "error", text: result.message });
                    else {
                      setMessage({
                        kind: "success",
                        text: data.isActive
                          ? "Employee deactivated."
                          : "Employee reactivated.",
                      });
                      reload();
                    }
                  }}
                >
                  {busy
                    ? "Saving…"
                    : data.isActive
                      ? "Deactivate employee"
                      : "Reactivate employee"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
      {canReadRates ? (
        <RateHistory employeeId={id} editable={editable} today={today} />
      ) : null}
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/employees"
        >
          Back to employees
        </Link>
      </p>
    </>
  );
}
