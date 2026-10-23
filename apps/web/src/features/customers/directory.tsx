"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Field, TextField } from "@/components/form/field";
import { Editor } from "./editor";
import { useRemote, type Customer } from "./remote";
export function Directory({ editable }: { editable: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [sort, setSort] = useState("name:asc");
  const [page, setPage] = useState(1);
  const [field, direction] = sort.split(":");
  const params = new URLSearchParams({
    q: search,
    status,
    page: String(page),
    pageSize: "20",
    sort: field!,
    direction: direction!,
  });
  const { data, error, reload } = useRemote<{
    customers: Customer[];
    total: number;
    pageSize: number;
  }>(`/api/customers?${params}`);
  return (
    <>
      <PageHeader
        title="Customers"
        description="Billing details, contacts and job sites."
        actions={
          editable && !creating ? (
            <Button onClick={() => setCreating(true)}>Add customer</Button>
          ) : null
        }
      />
      {creating ? (
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">Add customer</h2>
          <Editor
            kind="customer"
            url="/api/customers"
            onCancel={() => setCreating(false)}
            onSaved={(body) => {
              router.push(`/customers/${(body as Customer).id}`);
            }}
          />
        </section>
      ) : null}
      <form
        className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(q);
          setPage(1);
        }}
      >
        <TextField
          id="customer-search"
          label="Search customers"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          maxLength={100}
          placeholder="Name, email, ABN or suburb"
        />
        <Field id="customer-status" label="Status">
          {(control) => (
            <select
              {...control}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All customers</option>
            </select>
          )}
        </Field>
        <Field id="customer-sort" label="Sort by">
          {(control) => (
            <select
              {...control}
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
            >
              <option value="name:asc">Name A–Z</option>
              <option value="name:desc">Name Z–A</option>
              <option value="suburb:asc">Suburb A–Z</option>
              <option value="createdAt:desc">Newest first</option>
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
        <p role="status">Loading customers…</p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {data.total} {data.total === 1 ? "customer" : "customers"} · Page{" "}
            {page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          {data.customers.length === 0 ? (
            <div className="rounded-lg border bg-card p-8">
              <h2 className="text-xl font-semibold">
                {search ? "No matching customers" : "No customers to show"}
              </h2>
              <p className="mt-2 text-muted-foreground">
                {search
                  ? "Try another search or status filter."
                  : editable
                    ? "Add a customer to keep their billing details and job sites together."
                    : "Customers will appear here when your team adds them."}
              </p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                <table className="w-full text-left">
                  <caption className="sr-only">Customer directory</caption>
                  <thead>
                    <tr className="border-b bg-muted">
                      <th className="p-4">Customer</th>
                      <th className="p-4">Billing contact</th>
                      <th className="p-4">Suburb</th>
                      <th className="p-4">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.customers.map((customer) => (
                      <tr key={customer.id} className="border-b last:border-0">
                        <td className="p-4">
                          <Link
                            className="inline-flex min-h-11 items-center font-medium underline"
                            href={`/customers/${customer.id}`}
                          >
                            {customer.name}
                          </Link>
                        </td>
                        <td className="p-4 break-all">
                          {customer.billingEmail ??
                            customer.billingPhone ??
                            "—"}
                        </td>
                        <td className="p-4">{customer.suburb ?? "—"}</td>
                        <td className="p-4">
                          {customer.archivedAt ? "Archived" : "Active"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="space-y-3 md:hidden">
                {data.customers.map((customer) => (
                  <li
                    key={customer.id}
                    className="space-y-2 rounded-lg border bg-card p-4"
                  >
                    <Link
                      className="inline-flex min-h-11 items-center font-semibold underline"
                      href={`/customers/${customer.id}`}
                    >
                      {customer.name}
                    </Link>
                    <p className="break-all">
                      {customer.billingEmail ??
                        customer.billingPhone ??
                        "No billing contact"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {customer.suburb ?? "No suburb"} ·{" "}
                      {customer.archivedAt ? "Archived" : "Active"}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          <nav aria-label="Customer pages" className="flex flex-wrap gap-3">
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
