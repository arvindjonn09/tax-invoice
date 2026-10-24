"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/data/use-remote";
import { InvoiceBuilder } from "./builder";
import { DraftInvoiceView } from "./draft-view";
import { IssuedInvoice } from "./issued";
import { type GstRegistrationPeriod, gstStatusOn } from "@jobflow/domain";
import type { Invoice } from "./types";

/**
 * Loads one document, then shows the draft builder (read only without
 * invoice.write) or the issued view.
 */
export function InvoicePage({
  id,
  periods,
  today,
  canWrite,
  canIssue,
}: {
  id: string;
  periods: GstRegistrationPeriod[];
  today: string;
  canWrite: boolean;
  canIssue: boolean;
}) {
  const params = useSearchParams();
  const remote = useRemote<Invoice>(`/api/invoices/${id}`);
  const [issued, setIssued] = useState<Invoice | null>(null);
  const [voided, setVoided] = useState<Invoice | null>(null);
  const { error, reload } = remote;
  const data = voided ?? issued ?? remote.data;
  const original = useRemote<Pick<Invoice, "reference" | "gstRegistered">>(
    data?.creditsId ? `/api/invoices/${data.creditsId}` : null,
  );
  if (!data)
    return error ? (
      <div role="alert">
        <p>{error}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    ) : (
      <p role="status" aria-busy="true">
        Loading invoice…
      </p>
    );
  const creditsReference = original.data?.reference ?? null;
  if (data.status === "draft" && !canWrite)
    return (
      <DraftInvoiceView
        invoice={data}
        registered={
          data.kind === "credit_note"
            ? (original.data?.gstRegistered ?? null)
            : gstStatusOn(periods, today).registered
        }
        creditsReference={creditsReference}
      />
    );
  return data.status === "draft" ? (
    <InvoiceBuilder
      key={data.id}
      initial={data}
      periods={periods}
      originalRegistered={original.data?.gstRegistered ?? null}
      today={today}
      canIssue={canIssue}
      creditsReference={creditsReference}
      onIssued={setIssued}
    />
  ) : (
    <IssuedInvoice
      key={`${data.id}:${data.status}`}
      invoice={data}
      canIssue={canIssue}
      justIssued={
        voided === null && (issued !== null || params.get("issued") === "1")
      }
      justVoided={voided !== null}
      onVoided={setVoided}
      creditsReference={creditsReference}
    />
  );
}
