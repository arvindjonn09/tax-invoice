"use client";
import Link from "next/link";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { PageHeader } from "@/components/shell/page-header";
import { MoneyDisplay, formatAudCents } from "@/components/money-display";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { day, time, statusLabel } from "@/features/jobs/types";
import { EvidencePanel } from "./evidence";
import type { OwnOffer } from "./types";
export function PortalDetail({ id }: { id: string }) {
  const { data, error, reload } = useRemote<OwnOffer>(`/api/my/offers/${id}`);
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  useUnsavedChanges(dirty);
  if (!data)
    return (
      <>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={reload}>Try again</Button>
          </div>
        ) : (
          <p role="status">Loading your offer…</p>
        )}
      </>
    );
  return (
    <>
      <PageHeader
        title={`${data.job.reference} · ${data.job.title}`}
        description={`Offer: ${statusLabel(data.status)} · Job: ${statusLabel(data.job.status)}`}
        breadcrumbs={[
          { label: "My offers", href: "/offers" },
          { label: data.job.reference },
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
      <section className="min-w-0 space-y-4 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]">
        <h2 className="text-xl font-semibold">Your offered work</h2>
        <p>Due {day(data.job.dueOn)}</p>
        <p className="whitespace-pre-wrap">{data.scope}</p>
        <p>
          {data.rateType === "fixed" ? "Fixed price" : "Hourly rate"}:{" "}
          <MoneyDisplay
            cents={BigInt(data.rateExclusiveCents)}
            basis="ex GST"
          />
          {data.estimatedHours
            ? ` · ${data.estimatedHours} estimated hours`
            : ""}
        </p>
        <p>{data.taxCode.replaceAll("_", " ")}</p>
        {data.exclusiveCents !== null &&
        data.gstCents !== null &&
        data.inclusiveCents !== null ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt>Your amount ex GST</dt>
              <dd>
                <MoneyDisplay
                  cents={BigInt(data.exclusiveCents)}
                  basis="ex GST"
                />
              </dd>
            </div>
            <div>
              <dt>Your GST</dt>
              <dd>{formatAudCents(BigInt(data.gstCents))} AUD</dd>
            </div>
            <div>
              <dt>Your total incl GST</dt>
              <dd>
                <MoneyDisplay
                  cents={BigInt(data.inclusiveCents)}
                  basis="incl GST"
                />
              </dd>
            </div>
          </dl>
        ) : (
          <p>
            The terms need an office update before acceptance because your GST
            registration changed.
          </p>
        )}
        {data.acceptance ? (
          <p className="rounded-lg bg-muted p-4">
            Accepted {time(data.acceptance.acceptedAt)}. These agreed terms are
            preserved as an immutable snapshot.
          </p>
        ) : null}
        {data.respondedAt ? (
          <p>
            Response {time(data.respondedAt)}
            {data.responseNote ? ` · ${data.responseNote}` : ""}
          </p>
        ) : null}
        {!data.contractorActive ? (
          <p role="status">
            Your contractor access is inactive. Contact the office about new
            work.
          </p>
        ) : null}
        {data.status === "offered" &&
        data.contractorActive &&
        !["closed", "cancelled", "invoiced"].includes(data.job.status) ? (
          <form
            className="space-y-4 border-t pt-4"
            onChange={() => setDirty(true)}
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              const form = new FormData(e.currentTarget),
                decision = String(form.get("decision"));
              if (
                !window.confirm(
                  decision === "accept"
                    ? "Accept this work at the terms shown? Your acceptance is recorded and the agreed terms cannot be edited."
                    : "Decline this offer? Your response will be recorded.",
                )
              )
                return;
              setBusy(true);
              const result = await sendJson(`/api/my/offers/${id}`, "POST", {
                decision,
                note: String(form.get("note") ?? "").trim() || null,
              });
              setBusy(false);
              if (!result.ok) {
                setMessage({ kind: "error", text: result.message });
                return;
              }
              setDirty(false);
              setMessage({
                kind: "success",
                text:
                  decision === "accept" ? "Offer accepted." : "Offer declined.",
              });
              reload();
            }}
          >
            <fieldset className="space-y-4" disabled={busy}>
              <legend className="mb-3 font-semibold">
                Respond to this offer
              </legend>
              <Field id="offer-decision" label="Your decision">
                {(control) => (
                  <select {...control} name="decision" defaultValue="accept">
                    <option value="accept">Accept work</option>
                    <option value="decline">Decline work</option>
                  </select>
                )}
              </Field>
              <Field id="response-note" label="Response note">
                {(control) => (
                  <textarea
                    {...control}
                    className={`${control.className} min-h-24 py-3`}
                    name="note"
                    maxLength={500}
                  />
                )}
              </Field>
            </fieldset>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Send response"}
            </Button>
          </form>
        ) : null}
        <FormMessage message={message} />
      </section>
      {data.status === "accepted" && data.contractorActive ? (
        <EvidencePanel
          jobId={data.jobId}
          status={data.job.status}
          refresh={reload}
        />
      ) : null}
      <section className="space-y-2 rounded-lg border bg-card p-6">
        <h2 className="text-xl font-semibold">Bill submission</h2>
        <p>
          Bill submission will be available here in a later release. Contact the
          office about billing.
        </p>
      </section>
      <Link
        className="inline-flex min-h-11 items-center underline"
        href="/offers"
      >
        Back to my offers
      </Link>
    </>
  );
}
