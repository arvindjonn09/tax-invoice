"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { formatAudCents } from "@/components/money-display";
import { day, time } from "@/features/jobs/types";
import { Totals } from "./totals";
import { type Invoice, documentName, taxLabel } from "./types";

type Party = NonNullable<Invoice["customer"]>;
const lines = (party: Party | null) =>
  party
    ? [
        party.legalName ?? party.name ?? party.label,
        party.legalName && party.name !== party.legalName ? party.name : null,
        party.abn ? `ABN ${party.abn}` : null,
        party.addressLine1,
        party.addressLine2,
        [party.suburb, party.state, party.postcode].filter(Boolean).join(" "),
      ].filter((line): line is string => Boolean(line))
    : [];

/** An issued (or void) invoice or credit note: read only, by design. */
export function IssuedInvoice({
  invoice,
  canIssue,
  justIssued,
  justVoided = false,
  creditsReference,
  onVoided,
}: {
  invoice: Invoice;
  canIssue: boolean;
  justIssued: boolean;
  justVoided?: boolean;
  creditsReference: string | null;
  /** Show the void document the API returned (status, reason, actions). */
  onVoided?: (voided: Invoice) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(
    justVoided
      ? { kind: "success", text: `${invoice.reference} is void.` }
      : justIssued
        ? {
            kind: "success",
            text: `${invoice.title} ${invoice.reference} issued. It can no longer be edited.`,
          }
        : null,
  );
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const voidDialog = useRef<HTMLDialogElement>(null);
  const cancelVoid = useRef<HTMLButtonElement>(null);
  const voidButton = useRef<HTMLButtonElement>(null);
  const isInvoice = invoice.kind === "invoice";
  const isVoid = invoice.status === "void";
  const liveCredits =
    invoice.creditNotes?.filter((credit) => credit.status === "issued") ?? [];
  return (
    <>
      <PageHeader
        title={`${invoice.title ?? "Invoice"} ${invoice.reference ?? ""}`.trim()}
        description={
          isVoid
            ? `Void — ${invoice.voidReason ?? ""}`
            : `Issued — read only (locked) · ${invoice.issueDate ? day(invoice.issueDate) : ""}`
        }
        breadcrumbs={[
          { label: "Invoices", href: "/invoices" },
          { label: invoice.reference ?? "Invoice" },
        ]}
        actions={
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const result = await sendJson(
                  `/api/invoices/${invoice.id}/pdf`,
                  "POST",
                  {},
                );
                setBusy(false);
                if (!result.ok) {
                  setMessage({
                    kind: "error",
                    text: `PDF could not be generated. ${result.message}`,
                  });
                  return;
                }
                setLink(result.body as { url: string; expiresAt: string });
              }}
            >
              Get PDF
            </Button>
            {canIssue && isInvoice && !isVoid ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const result = await sendJson(
                    `/api/invoices/${invoice.id}/credit-notes`,
                    "POST",
                    {},
                  );
                  setBusy(false);
                  if (!result.ok) {
                    setMessage({ kind: "error", text: result.message });
                    return;
                  }
                  router.push(
                    `/invoices/${(result.body as { id: string }).id}`,
                  );
                }}
              >
                Create credit note
              </Button>
            ) : null}
            {canIssue && !isVoid ? (
              <Button
                variant="outline"
                disabled={busy}
                ref={voidButton}
                onClick={() => {
                  voidDialog.current?.showModal();
                  cancelVoid.current?.focus();
                }}
              >
                Void {documentName(invoice)}
              </Button>
            ) : null}
          </div>
        }
      />
      <FormMessage message={message} />
      {link ? (
        <p role="status" className="rounded-lg border bg-card p-4">
          <a
            className="inline-flex min-h-11 items-center font-semibold underline"
            href={link.url}
          >
            Download PDF ({invoice.reference})
          </a>{" "}
          · private link, expires {time(link.expiresAt)}
        </p>
      ) : null}
      {creditsReference ? (
        <p>
          Credits invoice{" "}
          <Link className="underline" href={`/invoices/${invoice.creditsId}`}>
            {creditsReference}
          </Link>
          .
        </p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="grid gap-4 rounded-lg border bg-card p-6 sm:grid-cols-3 [overflow-wrap:anywhere]">
            {(
              [
                ["From", invoice.supplier],
                ["To", invoice.customer],
                ["Site", invoice.site],
              ] as const
            ).map(([label, party]) =>
              party ? (
                <div key={label}>
                  <h2 className="text-sm font-semibold uppercase text-muted-foreground">
                    {label}
                  </h2>
                  {lines(party).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : null,
            )}
          </section>
          <section
            aria-labelledby="lines-heading"
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <h2 id="lines-heading" className="text-xl font-semibold">
              Lines
            </h2>
            <ol className="space-y-3">
              {invoice.lines.map((line, index) => (
                <li
                  key={line.id}
                  className="rounded-lg border p-4 [overflow-wrap:anywhere]"
                >
                  <p className="font-semibold">
                    {index + 1}. {line.description}
                  </p>
                  <p className="text-sm tabular-nums">
                    {line.quantity}
                    {line.unit ? ` ${line.unit}` : ""} ×{" "}
                    {formatAudCents(BigInt(line.unitPriceCents))} (
                    {invoice.priceEntry === "exclusive" ? "ex" : "incl"} GST) ·{" "}
                    {taxLabel(line.taxCode)}
                  </p>
                  <p className="text-sm tabular-nums">
                    {formatAudCents(BigInt(line.exclusiveCents))} ex GST ·{" "}
                    {formatAudCents(BigInt(line.gstCents))} GST ·{" "}
                    {formatAudCents(BigInt(line.inclusiveCents))} incl GST
                  </p>
                </li>
              ))}
            </ol>
            {invoice.notes ? (
              <>
                <h3 className="font-semibold">Notes</h3>
                <p className="whitespace-pre-wrap">{invoice.notes}</p>
              </>
            ) : null}
          </section>
          {liveCredits.length ? (
            <section className="rounded-lg border bg-card p-6">
              <h2 className="text-xl font-semibold">Credit notes</h2>
              <ul>
                {liveCredits.map((credit) => (
                  <li key={credit.id}>
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      href={`/invoices/${credit.id}`}
                    >
                      {credit.reference}
                    </Link>{" "}
                    · {formatAudCents(BigInt(credit.inclusiveCents))} incl GST
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <aside>
          <Totals
            totals={invoice}
            stale={false}
            registered={invoice.gstRegistered}
          />
          {invoice.issuedAt ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Issued {time(invoice.issuedAt)}
            </p>
          ) : null}
        </aside>
      </div>
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/invoices"
        >
          Back to invoices
        </Link>
      </p>
      <dialog
        ref={voidDialog}
        aria-labelledby="void-heading"
        onClose={() => voidButton.current?.focus()}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border bg-card p-6 text-card-foreground backdrop:bg-black/50"
      >
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            const result = await sendJson(
              `/api/invoices/${invoice.id}/void`,
              "POST",
              {
                reason,
              },
            );
            setBusy(false);
            voidDialog.current?.close();
            if (!result.ok) {
              setMessage({ kind: "error", text: result.message });
              return;
            }
            setMessage({
              kind: "success",
              text: `${invoice.reference} is void.`,
            });
            // The page's fetched copy wouldn't change on refresh: hand the
            // returned void document up so status and actions update now.
            if (onVoided) onVoided(result.body as Invoice);
            else router.refresh();
          }}
        >
          <h2 id="void-heading" className="text-xl font-semibold">
            Void {invoice.reference}?
          </h2>
          <p>
            A void is final and recorded with your name and reason. If the
            customer has been invoiced correctly but owes less, create a credit
            note instead.
          </p>
          <Field id="void-reason" label="Reason (required)">
            {(control) => (
              <textarea
                {...control}
                className={`${control.className} min-h-24 py-3`}
                required
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button
              ref={cancelVoid}
              type="button"
              variant="outline"
              onClick={() => voidDialog.current?.close()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || !reason.trim()}
            >
              {busy ? "Voiding…" : `Void ${documentName(invoice)}`}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
