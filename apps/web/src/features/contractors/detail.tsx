"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { FormMessage, sendJson } from "@/components/form/field";
import { useRemote } from "@/components/data/use-remote";
import { ContractorEditor } from "./editor";
import { OfferEditor, OfferHistory } from "./offers";
import type { Contractor, Offer } from "./types";
export function ContractorDetail({
  id,
  editable,
}: {
  id: string;
  editable: boolean;
}) {
  const { data, error, reload } = useRemote<Contractor & { offers: Offer[] }>(
    `/api/contractors/${id}`,
  );
  const [editing, setEditing] = useState(false),
    [offering, setOffering] = useState<Offer | true | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  if (!data)
    return (
      <>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={reload}>Try again</Button>
          </div>
        ) : (
          <p role="status">Loading contractor…</p>
        )}
      </>
    );
  return (
    <>
      <PageHeader
        title={data.name}
        description={
          data.archivedAt ? "Archived contractor" : "Active contractor"
        }
        breadcrumbs={[
          { label: "Contractors", href: "/contractors" },
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
        <h2 className="text-xl font-semibold">Contractor details</h2>
        {editing ? (
          <ContractorEditor
            initial={data}
            saved={() => {
              setEditing(false);
              reload();
            }}
            cancel={() => setEditing(false)}
          />
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">ABN</dt>
                <dd>{data.abn ?? "Not provided"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">GST registration</dt>
                <dd>{data.gstRegistered ? "Registered" : "Not registered"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Email</dt>
                <dd>{data.email ?? "Not provided"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Phone</dt>
                <dd>{data.phone ?? "Not provided"}</dd>
              </div>
            </dl>
            {editable && !offering ? (
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => setEditing(true)}>
                  Edit contractor
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        data.archivedAt
                          ? "Restore this contractor to the active directory?"
                          : "Archive this contractor? New offers and responses will be blocked; existing history remains.",
                      )
                    )
                      return;
                    setBusy(true);
                    const result = await sendJson(
                      `/api/contractors/${id}`,
                      "PATCH",
                      { archived: !data.archivedAt },
                    );
                    setBusy(false);
                    if (!result.ok)
                      setMessage({ kind: "error", text: result.message });
                    else {
                      setMessage({
                        kind: "success",
                        text: data.archivedAt
                          ? "Contractor restored."
                          : "Contractor archived.",
                      });
                      reload();
                    }
                  }}
                >
                  {busy
                    ? "Saving…"
                    : data.archivedAt
                      ? "Restore contractor"
                      : "Archive contractor"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
      <section className="space-y-4 rounded-lg border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">
            Offers and acceptance history
          </h2>
          {editable && !data.archivedAt && !offering && !editing ? (
            <Button onClick={() => setOffering(true)}>Create offer</Button>
          ) : null}
        </div>
        {offering ? (
          <div className="rounded-lg border p-4">
            <h3 className="mb-4 font-semibold">
              {offering === true ? "Create offer" : "Edit offer"}
            </h3>
            <OfferEditor
              contractor={data}
              {...(offering === true ? {} : { initial: offering })}
              saved={() => {
                setOffering(null);
                reload();
              }}
              cancel={() => setOffering(null)}
            />
          </div>
        ) : null}
        <OfferHistory
          offers={data.offers}
          editable={editable && !offering && !editing}
          edit={setOffering}
          refresh={reload}
        />
      </section>
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/contractors"
        >
          Back to contractors
        </Link>
      </p>
    </>
  );
}
