"use client";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { FormMessage, sendJson } from "@/components/form/field";
import { formatAudCents } from "@/components/money-display";
import { Button } from "@/components/ui/button";

/** A subcontractor's invoice waiting for the office (#139). */
type Submission = {
  id: string;
  contractorName: string | null;
  job: { reference: string; title: string };
  scope: string;
  supplierReference: string;
  issuedOn: string;
  dueOn: string | null;
  totalCents: string;
  lines: { description: string; exclusiveCents: string; gstCents: string }[];
  note: string | null;
  documentId: string;
  offer: { agreedInclusiveCents: string; billedInclusiveCents: string };
};

const aud = (cents: string) => `${formatAudCents(BigInt(cents))} AUD`;

/**
 * Subcontractor invoices to review. Approving checks the tax invoice and
 * records the supplier bill once; rejecting tells the subcontractor what to
 * change. Hidden when nothing is waiting.
 */
export function SubmissionQueue({
  canDecide,
  onDecided,
}: {
  canDecide: boolean;
  /** Refresh the bill list after an approval records a bill. */
  onDecided?: () => void;
}) {
  const { data, error, reload } = useRemote<{
    submissions: Submission[];
    total: number;
  }>("/api/bill-submissions?status=submitted&pageSize=50");
  const [busy, setBusy] = useState<string | null>(null),
    [verified, setVerified] = useState<Record<string, boolean>>({}),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [links, setLinks] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  if (error)
    return (
      <div role="alert" className="rounded-lg border bg-card p-4">
        <p>{error}</p>
        <Button variant="outline" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  if (!data || data.submissions.length === 0)
    return <FormMessage message={message} />;
  return (
    <section
      aria-labelledby="submissions-heading"
      className="space-y-4 rounded-lg border bg-card p-4"
    >
      <h3 id="submissions-heading" className="text-lg font-semibold">
        Subcontractor invoices to review ({data.total})
      </h3>
      <ul className="space-y-4">
        {data.submissions.map((s) => (
          <li key={s.id} className="space-y-3 rounded-lg bg-muted p-4">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <p className="font-semibold">
                {s.contractorName ?? "Subcontractor"} · invoice{" "}
                {s.supplierReference}
              </p>
              <p className="text-sm text-muted-foreground">
                {s.job.reference} · {s.job.title} · dated {s.issuedOn}
                {s.dueOn ? ` · due ${s.dueOn}` : ""}
              </p>
              <ul className="text-sm">
                {s.lines.map((line, index) => (
                  <li key={index}>
                    {line.description}: {aud(line.exclusiveCents)} ex GST +{" "}
                    {aud(line.gstCents)} GST
                  </li>
                ))}
              </ul>
              <p className="tabular-nums">Total {aud(s.totalCents)} incl GST</p>
              <p className="text-sm tabular-nums">
                Agreed for this work: {aud(s.offer.agreedInclusiveCents)} incl
                GST · already billed: {aud(s.offer.billedInclusiveCents)}
              </p>
              {s.note ? <p className="whitespace-pre-wrap">{s.note}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                disabled={busy !== null}
                aria-label={`Open tax invoice ${s.supplierReference}`}
                onClick={async () => {
                  setBusy(s.id);
                  const result = await sendJson(
                    `/api/documents/${s.documentId}/link`,
                    "POST",
                    {},
                  );
                  setBusy(null);
                  if (!result.ok)
                    return setMessage({ kind: "error", text: result.message });
                  setLinks((previous) => ({
                    ...previous,
                    [s.id]: (result.body as { url: string }).url,
                  }));
                }}
              >
                Open tax invoice
              </Button>
              {links[s.id] ? (
                <a className="underline" href={links[s.id]}>
                  Download (link expires soon)
                </a>
              ) : null}
            </div>
            {canDecide ? (
              <div className="space-y-3">
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={verified[s.id] ?? false}
                    onChange={(event) =>
                      setVerified((previous) => ({
                        ...previous,
                        [s.id]: event.target.checked,
                      }))
                    }
                  />
                  I checked invoice {s.supplierReference}: it&apos;s a valid tax
                  invoice and its lines, GST and total match
                </label>
                <label className="block space-y-1">
                  <span>
                    Message to the subcontractor for invoice{" "}
                    {s.supplierReference} (required to send back)
                  </span>
                  <textarea
                    className="min-h-20 w-full rounded-md border bg-background p-3"
                    maxLength={500}
                    value={notes[s.id] ?? ""}
                    onChange={(event) =>
                      setNotes((previous) => ({
                        ...previous,
                        [s.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={busy !== null || !verified[s.id]}
                    aria-label={`Approve invoice ${s.supplierReference} and record the bill`}
                    onClick={async () => {
                      setBusy(s.id);
                      const result = await sendJson(
                        `/api/bill-submissions/${s.id}/approve`,
                        "POST",
                        { evidenceVerified: true },
                      );
                      setBusy(null);
                      if (!result.ok)
                        return setMessage({
                          kind: "error",
                          text: result.message,
                        });
                      const billId = (result.body as { billId: string }).billId;
                      setMessage({
                        kind: "success",
                        text: `Approved: bill recorded (${billId.slice(0, 8)}).`,
                      });
                      reload();
                      onDecided?.();
                    }}
                  >
                    {busy === s.id ? "Saving…" : "Approve and record bill"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    aria-label={`Send invoice ${s.supplierReference} back`}
                    onClick={async () => {
                      setBusy(s.id);
                      const result = await sendJson(
                        `/api/bill-submissions/${s.id}/reject`,
                        "POST",
                        { note: notes[s.id]?.trim() ?? "" },
                      );
                      setBusy(null);
                      if (!result.ok)
                        return setMessage({
                          kind: "error",
                          text: result.message,
                        });
                      setMessage({
                        kind: "success",
                        text: "Sent back to the subcontractor.",
                      });
                      reload();
                    }}
                  >
                    Send back
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <FormMessage message={message} />
      <p className="text-sm text-muted-foreground">
        Approved invoices appear in the bills below.
      </p>
    </section>
  );
}
