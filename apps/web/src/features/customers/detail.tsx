"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { FormMessage, sendJson } from "@/components/form/field";
import { Editor } from "./editor";
import {
  useRemote,
  type Customer,
  type Contact,
  type Location,
} from "./remote";
export function CustomerDetail({
  id,
  editable,
}: {
  id: string;
  editable: boolean;
}) {
  const url = `/api/customers/${id}`;
  const { data, error, reload } = useRemote<
    Customer & { contacts: Contact[]; locations: Location[] }
  >(url);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  if (error && !data)
    return (
      <>
        <PageHeader title="Customer" />
        <div role="alert">
          <p>{error}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      </>
    );
  if (!data) return <p role="status">Loading customer…</p>;
  return (
    <>
      <PageHeader
        title={data.name}
        description={data.archivedAt ? "Archived customer" : "Active customer"}
        breadcrumbs={[
          { label: "Customers", href: "/customers" },
          { label: data.name },
        ]}
        actions={
          editable && !editing ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit customer
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `${data.archivedAt ? "Restore" : "Archive"} ${data.name}? Existing records will be kept.`,
                    )
                  )
                    return;
                  setBusy(true);
                  const result = await sendJson(url, "PATCH", {
                    archived: !data.archivedAt,
                  });
                  setBusy(false);
                  setMessage(
                    result.ok
                      ? { kind: "success", text: "Customer status updated." }
                      : { kind: "error", text: result.message },
                  );
                  if (result.ok) reload();
                }}
              >
                {busy
                  ? "Saving…"
                  : data.archivedAt
                    ? "Restore customer"
                    : "Archive customer"}
              </Button>
            </>
          ) : null
        }
      />
      {error ? (
        <div role="alert">
          <p>{error} Showing the last loaded details.</p>
          <Button onClick={reload} variant="outline">
            Try again
          </Button>
        </div>
      ) : null}
      <FormMessage message={message} />
      <section className="space-y-4 rounded-lg border bg-card p-6">
        <h2 className="text-xl font-semibold">Billing details</h2>
        {editing ? (
          <Editor
            kind="customer"
            url={url}
            initial={data}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setMessage({ kind: "success", text: "Customer saved." });
              reload();
            }}
          />
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            {[
              ["ABN", data.abn],
              ["Email", data.billingEmail],
              ["Phone", data.billingPhone],
              [
                "Billing address",
                [
                  data.addressLine1,
                  data.addressLine2,
                  data.suburb,
                  data.state,
                  data.postcode,
                ]
                  .filter(Boolean)
                  .join(", "),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words">{value || "Not provided"}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <Children
        kind="contact"
        rows={data.contacts}
        url={`${url}/contacts`}
        editable={editable}
        reload={reload}
      />
      <Children
        kind="location"
        rows={data.locations}
        url={`${url}/locations`}
        editable={editable}
        reload={reload}
      />
      <section className="space-y-2 rounded-lg border bg-card p-6">
        <h2 className="text-xl font-semibold">Job and invoice history</h2>
        <p className="text-muted-foreground">
          History will be available when the jobs and invoicing modules are
          connected.
        </p>
      </section>
      <Link
        href="/customers"
        className="inline-flex min-h-11 items-center underline"
      >
        Back to customers
      </Link>
    </>
  );
}
function Children({
  kind,
  rows,
  url,
  editable,
  reload,
}: {
  kind: "contact" | "location";
  rows: (Contact | Location)[];
  url: string;
  editable: boolean;
  reload: () => void;
}) {
  const [editor, setEditor] = useState<"new" | Contact | Location | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const title = kind === "contact" ? "Contacts" : "Job sites";
  return (
    <section
      aria-label={title}
      className="space-y-4 rounded-lg border bg-card p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        {editable && !editor ? (
          <Button variant="outline" onClick={() => setEditor("new")}>
            Add {kind === "contact" ? "contact" : "site"}
          </Button>
        ) : null}
      </div>
      <FormMessage message={message} />
      {editor ? (
        <Editor
          key={typeof editor === "string" ? editor : editor.id}
          kind={kind}
          url={editor === "new" ? url : `${url}/${editor.id}`}
          {...(editor === "new" ? {} : { initial: editor })}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setMessage({
              kind: "success",
              text: `${kind === "contact" ? "Contact" : "Site"} saved.`,
            });
            reload();
          }}
        />
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          No {kind === "contact" ? "contacts" : "sites"} added yet.
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-4 py-4"
            >
              <div className="min-w-0 flex-1 space-y-2 break-words">
                <h3 className="font-semibold">
                  {"name" in row ? row.name : row.label || row.addressLine1}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {row.archivedAt ? "Archived" : "Active"}
                  {"isPrimary" in row && row.isPrimary && !row.archivedAt
                    ? " · Primary contact"
                    : ""}
                </p>
                {"name" in row ? (
                  <>
                    <p>
                      {[row.position, row.email, row.phone]
                        .filter(Boolean)
                        .join(" · ") || "No contact details"}
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      {[
                        row.addressLine1,
                        row.addressLine2,
                        row.suburb,
                        row.state,
                        row.postcode,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    {row.accessNotes ? (
                      <p className="whitespace-pre-wrap">
                        Access: {row.accessNotes}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || Boolean(editor)}
                    onClick={() => setEditor(row)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || Boolean(editor)}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `${row.archivedAt ? "Restore" : "Archive"} this ${kind === "contact" ? "contact" : "site"}?`,
                        )
                      )
                        return;
                      setBusy(true);
                      const result = await sendJson(
                        `${url}/${row.id}`,
                        "PATCH",
                        { archived: !row.archivedAt },
                      );
                      setBusy(false);
                      setMessage(
                        result.ok
                          ? { kind: "success", text: "Status updated." }
                          : { kind: "error", text: result.message },
                      );
                      if (result.ok) reload();
                    }}
                  >
                    {row.archivedAt ? "Restore" : "Archive"}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
