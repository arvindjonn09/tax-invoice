"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { formatAudCents } from "@/components/money-display";
import { QuoteSummary } from "./summary";
import { type Quote, STATE_LABEL, taxLabel } from "./types";

type Decision = "accept" | "decline";

/** A sent or decided quote: read-only, with its decision actions. */
export function QuoteView({
  quote,
  editable,
  customerName,
  onChanged,
}: {
  quote: Quote;
  editable: boolean;
  customerName: string | null;
  onChanged: (quote: Quote) => void;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const label = `${quote.kind === "variation" ? "Variation" : "Quote"} ${quote.reference}`;
  const open = quote.state === "sent";

  function ask(next: Decision, button: HTMLButtonElement) {
    opener.current = button;
    setDecision(next);
    setNote("");
    setDialogError(null);
    dialog.current?.showModal();
    cancel.current?.focus();
  }

  async function decide() {
    if (!decision) return;
    setBusy(true);
    const result = await sendJson(
      `/api/quotes/${quote.id}/${decision}`,
      "POST",
      {
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    );
    setBusy(false);
    if (!result.ok) {
      setDialogError(result.message);
      return;
    }
    dialog.current?.close();
    setNote("");
    const next = result.body as Quote;
    onChanged(next);
    setMessage({
      kind: "success",
      text:
        decision === "accept"
          ? quote.kind === "variation"
            ? "Variation accepted. Its ex-GST amount was added to the job."
            : "Quote accepted. The job is approved with this quote's ex-GST price."
          : "Quote declined.",
    });
  }

  async function revise() {
    setBusy(true);
    const result = await sendJson(`/api/quotes/${quote.id}/revise`, "POST", {});
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: result.message });
      return;
    }
    router.push(`/quotes/${(result.body as Quote).id}`);
  }

  return (
    <>
      <PageHeader
        title={label}
        description={STATE_LABEL[quote.state]}
        breadcrumbs={[{ label: "Quotes", href: "/quotes" }, { label }]}
        actions={
          editable ? (
            <div className="flex flex-wrap gap-3">
              {open ? (
                <>
                  <Button
                    disabled={busy}
                    onClick={(event) => ask("accept", event.currentTarget)}
                  >
                    Record acceptance
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={(event) => ask("decline", event.currentTarget)}
                  >
                    Record decline
                  </Button>
                </>
              ) : null}
              {["sent", "declined"].includes(quote.status) ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void revise()}
                >
                  {busy ? "Working…" : "Revise"}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      <FormMessage message={message} />
      {quote.state === "expired" ? (
        <p className="rounded-lg bg-warning p-4 text-warning-foreground">
          This quote expired on {quote.validUntil} without a decision. Revise it
          to send a new price.
        </p>
      ) : null}
      {quote.status === "accepted" && quote.jobId ? (
        <p className="rounded-lg border bg-card p-4">
          Accepted.{" "}
          <Link
            className="font-semibold underline"
            href={`/jobs/${quote.jobId}`}
          >
            Open the job
          </Link>
        </p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section
            aria-labelledby="quote-details"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="quote-details" className="text-xl font-semibold">
              Details
            </h2>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">Customer</dt>
                <dd>{customerName ?? "Loading…"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Title</dt>
                <dd className="[overflow-wrap:anywhere]">{quote.title}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Sent on</dt>
                <dd>{quote.sentOn ?? "Not sent"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Valid until</dt>
                <dd>{quote.validUntil ?? "No expiry"}</dd>
              </div>
              {quote.decisionNote ? (
                <div className="sm:col-span-2">
                  <dt className="text-sm text-muted-foreground">
                    Decision note
                  </dt>
                  <dd className="[overflow-wrap:anywhere]">
                    {quote.decisionNote}
                  </dd>
                </div>
              ) : null}
            </dl>
            {quote.scope ? (
              <>
                <h3 className="font-semibold">Scope of work</h3>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {quote.scope}
                </p>
              </>
            ) : null}
          </section>
          <section
            aria-labelledby="quote-lines"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="quote-lines" className="text-xl font-semibold">
              Lines
            </h2>
            <ol className="space-y-3">
              {quote.lines.map((line, index) => (
                <li key={line.id} className="rounded-lg border p-4">
                  <p className="font-semibold [overflow-wrap:anywhere]">
                    {index + 1}. {line.description}
                  </p>
                  <p className="text-sm tabular-nums">
                    {line.quantity}
                    {line.unit ? ` ${line.unit}` : ""} ·{" "}
                    {taxLabel(line.taxCode)}
                  </p>
                  <p className="text-sm tabular-nums">
                    {formatAudCents(BigInt(line.exclusiveCents))} ex GST ·{" "}
                    {formatAudCents(BigInt(line.gstCents))} GST ·{" "}
                    {formatAudCents(BigInt(line.inclusiveCents))} incl GST
                  </p>
                  {line.estimatedCostCents !== "0" ? (
                    <p className="text-sm text-muted-foreground tabular-nums">
                      Internal estimated cost{" "}
                      {formatAudCents(BigInt(line.estimatedCostCents))} ex GST
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            {quote.notes ? (
              <>
                <h3 className="font-semibold">Notes</h3>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {quote.notes}
                </p>
              </>
            ) : null}
          </section>
        </div>
        <aside>
          <QuoteSummary quote={quote} stale={false} />
        </aside>
      </div>
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/quotes"
        >
          Back to quotes
        </Link>
      </p>
      <dialog
        ref={dialog}
        aria-labelledby="decision-heading"
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border bg-card p-6 text-card-foreground backdrop:bg-black/50"
        onClose={() => opener.current?.focus()}
      >
        <div className="space-y-4">
          <h2 id="decision-heading" className="text-xl font-semibold">
            {decision === "accept"
              ? `Record acceptance of ${quote.reference}?`
              : `Record decline of ${quote.reference}?`}
          </h2>
          <p>
            {decision === "accept"
              ? quote.kind === "variation"
                ? `This adds ${formatAudCents(BigInt(quote.exclusiveCents))} ex GST to the job's estimated revenue. It can't be undone.`
                : `This approves the job with estimated revenue of ${formatAudCents(BigInt(quote.exclusiveCents))} ex GST. It can't be undone.`
              : "The customer's decision is recorded once. You can still revise the quote afterwards."}
          </p>
          <Field id="decision-note" label="Note (optional)">
            {(control) => (
              <textarea
                {...control}
                className={`${control.className} min-h-20 py-3`}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </Field>
          {dialogError ? (
            <p
              role="alert"
              className="rounded-lg bg-danger p-3 text-danger-foreground"
            >
              {dialogError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              ref={cancel}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={() => void decide()}>
              {busy
                ? "Saving…"
                : decision === "accept"
                  ? "Record acceptance"
                  : "Record decline"}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
