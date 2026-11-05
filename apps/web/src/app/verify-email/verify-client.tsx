"use client";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Turnstile } from "@/components/turnstile";
import { Button, buttonVariants } from "@/components/ui/button";

type State =
  | { kind: "loading" }
  | { kind: "confirm"; token: string }
  | { kind: "checking"; token: string }
  | { kind: "verified" }
  | { kind: "invalid" }
  | { kind: "resend" }
  | { kind: "resent" }
  | { kind: "error"; message: string };

/**
 * Reads the token from the URL fragment (never sent to servers or logs) and
 * removes it from the address bar (S3). The token is spent only when the person
 * presses the button, so a mail scanner that runs scripts can't verify an
 * address for someone who signed up with it.
 */
export function VerifyEmail({
  turnstileSiteKey,
}: {
  turnstileSiteKey: string | null;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const tokenRead = useRef(false);

  useEffect(() => {
    // Strict Mode runs this twice, and the first run removes the fragment.
    if (tokenRead.current) return;
    tokenRead.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    window.history.replaceState(null, "", window.location.pathname);
    queueMicrotask(() =>
      setState(token ? { kind: "confirm", token } : { kind: "resend" }),
    );
  }, []);

  async function onConfirm(token: string) {
    setState({ kind: "checking", token });
    const response = await fetch("/api/account/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => undefined);
    setState(
      !response
        ? { kind: "error", message: "Check your connection and try again." }
        : { kind: response.ok ? "verified" : "invalid" },
    );
  }

  async function onResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/account/verification/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        ...(turnstileToken ? { turnstileToken } : {}),
      }),
    }).catch(() => undefined);
    setTurnstileToken(null);
    setAttempt((value) => value + 1);
    setState(
      response?.status === 202
        ? { kind: "resent" }
        : {
            kind: "error",
            message:
              response?.status === 429
                ? "Too many requests. Try again later."
                : "Enter a valid email address.",
          },
    );
  }

  if (state.kind === "loading") {
    return <p role="status">Checking your link…</p>;
  }
  if (state.kind === "confirm" || state.kind === "checking") {
    return (
      <div className="space-y-4">
        <p>Press the button to confirm this email address is yours.</p>
        <Button
          type="button"
          disabled={state.kind === "checking"}
          onClick={() => void onConfirm(state.token)}
        >
          {state.kind === "checking" ? "Confirming…" : "Confirm my email"}
        </Button>
      </div>
    );
  }
  if (state.kind === "verified") {
    return (
      <div role="status" className="space-y-4">
        <h2 className="text-2xl font-semibold">Email verified</h2>
        <p>Thanks. Sign in to set up your business.</p>
        <Link href="/home" className={buttonVariants()}>
          Continue
        </Link>
      </div>
    );
  }
  if (state.kind === "resent") {
    return (
      <p role="status">
        If that address has an account waiting for verification, a new link is
        on its way. Check your inbox and spam folder.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {state.kind === "invalid" ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          This link is invalid or has expired.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {state.message}
        </p>
      ) : null}
      <h2 className="text-xl font-semibold">Get a new verification link</h2>
      <form onSubmit={onResend} noValidate className="space-y-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground"
          />
        </div>
        {turnstileSiteKey ? (
          <Turnstile
            key={attempt}
            siteKey={turnstileSiteKey}
            action="resend"
            onToken={setTurnstileToken}
          />
        ) : null}
        <Button
          type="submit"
          disabled={turnstileSiteKey !== null && turnstileToken === null}
        >
          Send a new link
        </Button>
      </form>
    </div>
  );
}
