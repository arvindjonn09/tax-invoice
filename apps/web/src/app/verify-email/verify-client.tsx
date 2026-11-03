"use client";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

type State =
  | { kind: "checking" }
  | { kind: "verified" }
  | { kind: "invalid" }
  | { kind: "resend" }
  | { kind: "resent" }
  | { kind: "error"; message: string };

/**
 * Reads the token from the URL fragment (never sent to servers or logs),
 * removes it from the address bar, then confirms it with the API (S3).
 */
export function VerifyEmail() {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    window.history.replaceState(null, "", window.location.pathname);
    async function check(): Promise<State> {
      if (!token) return { kind: "resend" };
      const response = await fetch("/api/account/verify-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }).catch(() => undefined);
      if (!response) {
        return {
          kind: "error",
          message: "Check your connection and try again.",
        };
      }
      return { kind: response.ok ? "verified" : "invalid" };
    }
    void check().then(setState);
  }, []);

  async function onResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/account/verification/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email") }),
    }).catch(() => undefined);
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

  if (state.kind === "checking") {
    return <p role="status">Checking your link…</p>;
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
        <Button type="submit">Send a new link</Button>
      </form>
    </div>
  );
}
