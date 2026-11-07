"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { sydneyDateTime, waitText } from "./format";

const MAX = 1000;

type Pending = { createdAt: string } | null;
type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

/** The owner's request form, or the pending request (design §12, S14). */
export function RequestExtension({
  supportEmail,
  pending,
}: {
  supportEmail: string;
  pending: Pending;
}) {
  const router = useRouter();
  const id = useId();
  const [message, setMessage] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const email = (
    <a
      className="font-semibold underline [overflow-wrap:anywhere]"
      href={`mailto:${supportEmail}`}
    >
      {supportEmail}
    </a>
  );

  if (state.kind === "sent") {
    return (
      <p
        ref={(node) => node?.focus()}
        tabIndex={-1}
        role="status"
        className="rounded-lg bg-success p-4 text-success-foreground"
      >
        Request sent. We&apos;ll email you when it&apos;s decided. You can also
        email {email}.
      </p>
    );
  }
  if (pending) {
    return (
      <div className="space-y-3">
        <p className="flex flex-wrap items-center gap-3">
          <StatusPill status="pending" />
          <span>
            Requested {sydneyDateTime(pending.createdAt)}. We&apos;ll email you
            when it&apos;s decided.
          </span>
        </p>
        <p className="text-muted-foreground">Or email {email}.</p>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (message.length > MAX) return;
    setState({ kind: "pending" });
    const response = await fetch("/api/company/trial/extension-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message.trim() ? { message: message.trim() } : {}),
    }).catch(() => undefined);
    if (response?.status === 201) {
      setState({ kind: "sent" });
      router.refresh();
      return;
    }
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    } | null;
    if (response?.status === 409 && result?.code === "request_pending") {
      setState({ kind: "idle" });
      router.refresh();
      return;
    }
    setState({
      kind: "error",
      message:
        response?.status === 429
          ? `You can send another request ${waitText(result?.retryAfterSeconds ?? 3600)}.`
          : (result?.error ?? "Something went wrong. Try again."),
    });
  }

  const tooLong = message.length > MAX;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {state.kind === "error" ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {state.message} You can also email {email}.
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-message`}>Message (optional)</label>
        <textarea
          id={`${id}-message`}
          name="message"
          rows={4}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          aria-invalid={tooLong ? true : undefined}
          aria-describedby={`${id}-count`}
          className="rounded-sm border border-input bg-card p-3 text-card-foreground"
        />
        <p
          id={`${id}-count`}
          aria-live="polite"
          className={
            tooLong
              ? "text-sm text-danger-foreground"
              : "text-sm text-muted-foreground"
          }
        >
          {message.length} of {MAX} characters
          {tooLong ? ". Use 1000 characters or fewer." : ""}
        </p>
      </div>
      <Button type="submit" disabled={state.kind === "pending" || tooLong}>
        {state.kind === "pending" ? "Sending…" : "Request extension"}
      </Button>
      <p className="text-muted-foreground">Or email {email}.</p>
    </form>
  );
}
