"use client";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  AccountField,
  ProblemSummary,
} from "@/components/account/account-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { retryAfter, throttledText } from "@/lib/retry";

type State =
  | { kind: "loading" }
  | { kind: "form"; token: string }
  | { kind: "pending"; token: string }
  | {
      kind: "error";
      token: string;
      message: string;
      fields: Record<string, string>;
    }
  | { kind: "throttled"; token: string; message: string; waitMs: number }
  | { kind: "done" }
  | { kind: "invalid" };

const LABELS = {
  password: "New password",
  passwordConfirmation: "Confirm new password",
};

/**
 * Reset password (S4, docs/design/signup-trial.md §7). The token is read
 * from the fragment, kept only in memory and removed from the address bar
 * at once; the page sends Referrer-Policy: no-referrer (proxy).
 */
export function ResetForm() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const read = useRef(false);

  useEffect(() => {
    // Strict Mode runs this twice, and the first run removes the fragment.
    if (read.current) return;
    read.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    window.history.replaceState(null, "", window.location.pathname);
    queueMicrotask(() =>
      setState(token ? { kind: "form", token } : { kind: "invalid" }),
    );
  }, []);

  // After the server's wait, the button works again without a reload.
  const throttledToken = state.kind === "throttled" ? state.token : null;
  const waitMs = state.kind === "throttled" ? state.waitMs : 0;
  useEffect(() => {
    if (!throttledToken) return;
    const timer = setTimeout(
      () => setState({ kind: "form", token: throttledToken }),
      waitMs,
    );
    return () => clearTimeout(timer);
  }, [throttledToken, waitMs]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "form" && state.kind !== "error") return;
    const { token } = state;
    const element = event.currentTarget;
    const form = new FormData(element);
    setState({ kind: "pending", token });
    const response = await fetch("/api/account/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        password: form.get("password"),
        passwordConfirmation: form.get("passwordConfirmation"),
      }),
    }).catch(() => undefined);
    if (response?.ok) {
      setState({ kind: "done" });
      return;
    }
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      code?: string;
      fields?: Record<string, string>;
      retryAfterSeconds?: number;
    } | null;
    if (result?.code === "token_invalid") return setState({ kind: "invalid" });
    if (response?.status === 429) {
      const seconds = retryAfter(response, result);
      return setState({
        kind: "throttled",
        token,
        message: throttledText(seconds),
        // No wait given: let them try again after a minute (Codex P2).
        waitMs: (seconds ?? 60) * 1000,
      });
    }
    // Password fields are cleared after a server rejection (Forms).
    element.reset();
    setState({
      kind: "error",
      token,
      message:
        !response || response.status >= 500
          ? "Something went wrong. Try again."
          : (result?.error ?? "Something went wrong. Try again."),
      fields: result?.fields ?? {},
    });
  }

  if (state.kind === "loading") return <p role="status">Checking your link…</p>;
  if (state.kind === "done")
    return (
      <div role="status" className="space-y-4">
        <h2
          tabIndex={-1}
          ref={(node) => node?.focus()}
          className="text-2xl font-semibold"
        >
          Password changed
        </h2>
        <p>
          You&apos;ve been signed out everywhere. Sign in with your new
          password.
        </p>
        <Link href="/login" className={buttonVariants()}>
          Sign in
        </Link>
      </div>
    );
  if (state.kind === "invalid")
    return (
      <div role="alert" className="space-y-4">
        <h2
          tabIndex={-1}
          ref={(node) => node?.focus()}
          className="text-2xl font-semibold"
        >
          This link is invalid or has expired
        </h2>
        <p>Reset links work once and expire after an hour.</p>
        <Link href="/forgot-password" className={buttonVariants()}>
          Send a new link
        </Link>
      </div>
    );
  const fields = state.kind === "error" ? state.fields : {};
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {state.kind === "error" ? (
        <ProblemSummary
          message={state.message}
          fields={fields}
          labels={LABELS}
        />
      ) : null}
      {state.kind === "throttled" ? (
        <p
          role="status"
          className="rounded-lg bg-warning p-4 text-warning-foreground"
        >
          {state.message}
        </p>
      ) : null}
      <AccountField
        id="password"
        label={LABELS.password}
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters. A short phrase works well."
        minLength={12}
        maxLength={128}
        required
        error={fields.password}
      />
      <AccountField
        id="passwordConfirmation"
        label={LABELS.passwordConfirmation}
        type="password"
        autoComplete="new-password"
        required
        error={fields.passwordConfirmation}
      />
      <Button
        type="submit"
        aria-disabled={state.kind === "pending" || state.kind === "throttled"}
        disabled={state.kind === "throttled"}
      >
        {state.kind === "pending" ? "Changing password…" : "Change password"}
      </Button>
    </form>
  );
}
