"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/data/use-remote";
import { QuoteBuilder } from "./builder";
import type { Quote } from "./types";
import { QuoteView } from "./view";

/** Drafts open in the builder (for writers); everything else is read-only. */
export function QuotePage({
  id,
  editable,
  registeredToday,
  today,
}: {
  id: string;
  editable: boolean;
  registeredToday: boolean;
  today: string;
}) {
  const remote = useRemote<Quote>(`/api/quotes/${id}`);
  const [local, setLocal] = useState<Quote | null>(null);
  const quote = local ?? remote.data;
  const customer = useRemote<{ name: string }>(
    quote ? `/api/customers/${quote.customerId}` : null,
  );
  if (remote.error && !quote)
    return (
      <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
        <p>{remote.error}</p>
        <Button onClick={remote.reload}>Try again</Button>
      </div>
    );
  if (!quote) return <p role="status">Loading quote…</p>;
  if (quote.status === "draft" && editable)
    return (
      <QuoteBuilder
        initial={quote}
        registeredToday={registeredToday}
        today={today}
        onSent={setLocal}
      />
    );
  return (
    <QuoteView
      quote={quote}
      editable={editable}
      customerName={customer.data?.name ?? null}
      onChanged={setLocal}
    />
  );
}
