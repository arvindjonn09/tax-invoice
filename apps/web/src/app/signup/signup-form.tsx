"use client";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "sent" }
  | { kind: "error"; message: string; fields: Record<string, string> };

const inputClass =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";

function Field({
  id,
  label,
  error,
  hint,
  ...input
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
} & React.ComponentProps<"input">) {
  const described = [hint && `${id}-hint`, error && `${id}-error`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        name={id}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Self-service sign-up (S2). The server decides everything; this only posts. */
export function SignupForm({
  termsVersion,
  privacyVersion,
}: {
  termsVersion: string;
  privacyVersion: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState({ kind: "pending" });
    const response = await fetch("/api/account/sign-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        password: form.get("password"),
        passwordConfirmation: form.get("passwordConfirmation"),
        acceptTerms: form.get("acceptTerms") === "on",
        termsVersion,
        privacyVersion,
      }),
    }).catch(() => undefined);
    if (response?.status === 202) {
      setState({ kind: "sent" });
      return;
    }
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      fields?: Record<string, string>;
    } | null;
    setState({
      kind: "error",
      message:
        response?.status === 429
          ? "Too many sign-up attempts from this network. Try again later."
          : (result?.error ?? "Something went wrong. Try again."),
      fields: result?.fields ?? {},
    });
  }

  if (state.kind === "sent") {
    return (
      <div role="status" className="space-y-3">
        <h2 className="text-2xl font-semibold">Check your email</h2>
        <p className="text-muted-foreground">
          We&apos;ve sent a link to verify your address. Open it within 24
          hours, then sign in to set up your business.
        </p>
        <p className="text-sm text-muted-foreground">
          Nothing arrived? Check your spam folder, or{" "}
          <Link className="text-link underline" href="/verify-email">
            request a new link
          </Link>
          .
        </p>
      </div>
    );
  }

  const fields = state.kind === "error" ? state.fields : {};
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {state.kind === "error" ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {state.message}
        </p>
      ) : null}
      <Field
        id="name"
        label="Your name"
        autoComplete="name"
        required
        maxLength={200}
        error={fields.name}
      />
      <Field
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        maxLength={320}
        error={fields.email}
      />
      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters. A short phrase works well."
        required
        minLength={12}
        maxLength={128}
        error={fields.password}
      />
      <Field
        id="passwordConfirmation"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        required
        error={fields.passwordConfirmation}
      />
      <div className="flex items-start gap-3">
        <input
          id="acceptTerms"
          name="acceptTerms"
          type="checkbox"
          required
          className="mt-1 size-5 shrink-0"
          aria-invalid={fields.acceptTerms ? true : undefined}
          aria-describedby={
            fields.acceptTerms ? "acceptTerms-error" : undefined
          }
        />
        <label htmlFor="acceptTerms">
          I agree to the{" "}
          <Link className="text-link underline" href="/terms" target="_blank">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link className="text-link underline" href="/privacy" target="_blank">
            Privacy Policy
          </Link>
          .
        </label>
      </div>
      {fields.acceptTerms ? (
        <p id="acceptTerms-error" className="text-sm text-danger-foreground">
          {fields.acceptTerms}
        </p>
      ) : null}
      <Button
        type="submit"
        className="w-full"
        disabled={state.kind === "pending"}
      >
        {state.kind === "pending" ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
