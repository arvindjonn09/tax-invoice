"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";

const CONTROL =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";

/** Spaces and dashes go first, so a pasted "123 456" still fits (§13e). */
export const cleanCode = (value: string) => value.replace(/[\s-]/g, "");

/** What a reply from the verify call means for the operator (§13e). */
export function verifyProblem(
  status: number | undefined,
  json: { code?: string } | null,
  backup: boolean,
  appUrl: string,
): { message: string; restart?: boolean; clear?: boolean } {
  switch (json?.code) {
    case "INVALID_CODE":
      return {
        message:
          "That code didn't work. Check your app and try the newest code.",
        clear: true,
      };
    case "INVALID_BACKUP_CODE":
      return {
        message: "That backup code didn't work. Each code works once.",
        clear: true,
      };
    case "INVALID_TWO_FACTOR_COOKIE":
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return {
        message: "Your sign-in timed out. Sign in again.",
        restart: true,
      };
  }
  if (status === 429)
    return { message: "Too many attempts. Wait a few minutes and try again." };
  if (status === undefined || json === null || status === 401 || status === 403)
    return {
      message: `Your operator sign-in needs Cloudflare Access first. Open ${appUrl}/operator to sign in to Access, then sign in here again.`,
    };
  return {
    message: backup
      ? "That backup code didn't work. Each code works once."
      : "That code didn't work. Check your app and try the newest code.",
    clear: true,
  };
}

/** The authentication-code step on /login for operators (design §13e). */
export function TwoFactorStep({
  next,
  onRestart,
}: {
  next: string;
  onRestart: (message?: string) => void;
}) {
  const router = useRouter();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = backup ? code.trim() : cleanCode(code);
    if (!backup && !/^\d{6}$/.test(value)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    if (backup && !value) {
      setError("Enter a backup code.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch(
      `/api/auth/two-factor/${backup ? "verify-backup-code" : "verify-totp"}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: value }),
      },
    ).catch(() => undefined);
    setBusy(false);
    if (response?.ok) {
      // Operators only go on to operator pages (design §13e).
      router.push(next.startsWith("/operator") ? next : "/operator");
      router.refresh();
      return;
    }
    const json = (await response
      ?.clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    const problem = verifyProblem(
      response?.status,
      json,
      backup,
      window.location.origin,
    );
    if (problem.restart) {
      onRestart(problem.message);
      return;
    }
    if (problem.clear) setCode("");
    setError(problem.message);
  }

  async function cancel() {
    await fetch("/api/auth/sign-out", { method: "POST" }).catch(
      () => undefined,
    );
    onRestart();
  }

  const id = backup ? "backup-code" : "totp-code";
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <h2
        ref={(node) => node?.focus()}
        tabIndex={-1}
        className="text-xl font-semibold"
      >
        Enter your authentication code
      </h2>
      <p>Open your authenticator app and enter the 6-digit code for JobFlow.</p>
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <label htmlFor={id}>
          {backup ? "Backup code" : "Authentication code"}
        </label>
        <input
          key={id}
          id={id}
          name="code"
          inputMode={backup ? "text" : "numeric"}
          autoComplete={backup ? "off" : "one-time-code"}
          value={code}
          onChange={(event) =>
            setCode(backup ? event.target.value : cleanCode(event.target.value))
          }
          aria-invalid={error ? true : undefined}
          className={CONTROL}
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Verifying…" : "Verify"}
      </Button>
      <div className="flex flex-wrap gap-4">
        <button
          type="button"
          className="inline-flex min-h-11 items-center underline"
          onClick={() => {
            setBackup(!backup);
            setCode("");
            setError(null);
          }}
        >
          {backup ? "Use your authenticator app" : "Use a backup code instead"}
        </button>
        <button
          type="button"
          className="inline-flex min-h-11 items-center underline"
          onClick={() => void cancel()}
        >
          Cancel and sign out
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Lost your device? Ask for a new enrolment code on the server (
        <code>pnpm operator enrol-code --user &lt;id&gt;</code>), then set up
        two-factor again at /operator/mfa. Until then, the CLI does every
        operator task.
      </p>
    </form>
  );
}
