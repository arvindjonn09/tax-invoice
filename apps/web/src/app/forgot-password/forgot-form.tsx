"use client";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import {
  AccountField,
  ProblemSummary,
} from "@/components/account/account-field";
import { Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string; fields: Record<string, string> };

/**
 * Forgot password (S4, docs/design/signup-trial.md §6). The server answers
 * the same for every address, throttled or not, so the page does too. The
 * address is shown from the form's own state, never stored.
 */
export function ForgotForm({
  turnstileSiteKey,
}: {
  turnstileSiteKey: string | null;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind === "pending") return;
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setState({ kind: "pending" });
    const response = await fetch("/api/account/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        ...(turnstileToken ? { turnstileToken } : {}),
      }),
    }).catch(() => undefined);
    if (response?.status === 202) {
      setState({ kind: "sent", email: email.trim() });
      return;
    }
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      code?: string;
      fields?: Record<string, string>;
    } | null;
    setTurnstileToken(null);
    setAttempt((value) => value + 1);
    setState({
      kind: "error",
      message:
        result?.code === "turnstile_failed"
          ? "We couldn't complete the security check. Try again."
          : !response || response.status >= 500
            ? "Something went wrong. Try again."
            : (result?.error ?? "Something went wrong. Try again."),
      fields: result?.fields ?? {},
    });
  }

  if (state.kind === "sent") {
    return (
      <div role="status" className="space-y-4">
        <h2
          tabIndex={-1}
          ref={(node) => node?.focus()}
          className="text-2xl font-semibold"
        >
          Check your email
        </h2>
        <p>
          If an account exists for <strong>{state.email}</strong>, we&apos;ve
          sent a link to reset your password. It expires in 1 hour.
        </p>
        <Link className="text-link underline" href="/login">
          Back to sign in
        </Link>
      </div>
    );
  }
  const fields = state.kind === "error" ? state.fields : {};
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {state.kind === "error" ? (
        <ProblemSummary
          message={state.message}
          fields={fields}
          labels={{ email: "Email" }}
        />
      ) : null}
      <AccountField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        error={fields.email}
      />
      {turnstileSiteKey ? (
        <Turnstile
          key={attempt}
          siteKey={turnstileSiteKey}
          action="forgot"
          onToken={setTurnstileToken}
        />
      ) : null}
      <Button
        type="submit"
        aria-disabled={
          state.kind === "pending" ||
          (turnstileSiteKey !== null && turnstileToken === null)
        }
        disabled={turnstileSiteKey !== null && turnstileToken === null}
      >
        {state.kind === "pending" ? "Sending…" : "Send reset link"}
      </Button>
      <p>
        <Link className="text-link underline" href="/login">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
