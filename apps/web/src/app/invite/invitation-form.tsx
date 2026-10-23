"use client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
const control =
  "min-h-11 w-full min-w-0 rounded-sm border border-input bg-card px-4 text-card-foreground";
export function InvitationForm() {
  const token = useRef("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    // Retain only in memory. Never send the bearer token in a URL or Referer.
    if (window.location.hash) token.current = window.location.hash.slice(1);
    window.history.replaceState(null, "", "/invite");
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const name = String(form.get("name") ?? "").trim();
      const password = String(form.get("password") ?? "");
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: token.current,
          ...(name ? { name } : {}),
          ...(password ? { password } : {}),
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        fields?: Record<string, string>;
      };
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Sign in with your existing invited account, then reopen the original invitation link."
            : result.fields
              ? Object.values(result.fields).join(". ")
              : (result.error ?? "Unable to accept invitation."),
        );
      token.current = "";
      setAccepted(true);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to accept invitation. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (accepted)
    return (
      <section
        role="status"
        className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
      >
        <h2 className="text-xl font-semibold">Invitation accepted</h2>
        <p>Your company access is ready.</p>
        <Link className="underline" href="/login">
          Sign in to JobFlow
        </Link>
      </section>
    );
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
    >
      <p>
        New here? Enter your name and choose a password. Already have a JobFlow
        account?{" "}
        <Link className="underline" href="/login">
          Sign in
        </Link>
        , then reopen the original invitation link and leave these fields blank.
      </p>
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {error}
        </p>
      ) : null}
      <label className="block space-y-2">
        Name (new accounts)
        <input
          className={control}
          name="name"
          autoComplete="name"
          maxLength={200}
        />
      </label>
      <label className="block space-y-2">
        Password (new accounts, 12–128 characters)
        <input
          className={control}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
        />
      </label>
      <Button disabled={busy} type="submit">
        {busy ? "Accepting…" : "Accept invitation"}
      </Button>
    </form>
  );
}
