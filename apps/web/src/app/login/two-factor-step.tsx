"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useFocusWhen } from "@/lib/focus";

const CONTROL =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";

/** Spaces and dashes go first, so a pasted "123 456" still fits (§13e). */
export const cleanCode = (value: string) => value.replace(/[\s-]/g, "");

const minutes = (seconds: number) => {
  const n = Math.max(1, Math.ceil(seconds / 60));
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
};

export type VerifyProblem = {
  message: string;
  /** Back to the password form. */
  restart?: boolean;
  /** Empty the field: the code itself was wrong. */
  clear?: boolean;
  /** Keep Verify disabled this long (throttled). */
  waitSeconds?: number;
};

/** What a reply from the verify call means for the operator (§13e). */
export function verifyProblem(
  status: number | undefined,
  json: { code?: string; message?: string } | null,
  appUrl: string,
  retryAfterSeconds?: number,
): VerifyProblem {
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
  if (status === 429) {
    const wait =
      retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds : 60;
    return {
      message: `Too many attempts. You can try again in ${minutes(wait)}.`,
      waitSeconds: wait,
    };
  }
  // JobFlow's own 401, e.g. "Your session ended. Sign in again to continue."
  // (#323): JSON with a message. Cloudflare Access answers with a page.
  if (status === 401 && json?.message)
    return { message: json.message, restart: true };
  if (status === undefined || json === null || status === 401 || status === 403)
    return {
      message: `Your operator sign-in needs Cloudflare Access first. Open ${appUrl}/operator to sign in to Access, then sign in here again.`,
    };
  // A server error says nothing about the code, so keep what was typed.
  return { message: "Something went wrong. Try again." };
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
  const [error, setError] = useState<VerifyProblem | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const heading = useFocusWhen<HTMLHeadingElement>(true);
  const alert = useFocusWhen<HTMLParagraphElement>(error);

  // Verify stays off until a throttle's wait is over (§13e).
  useEffect(() => {
    if (!waitUntil) return;
    const timer = setTimeout(
      () => setWaitUntil(0),
      Math.max(0, waitUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [waitUntil]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = backup ? code.trim() : cleanCode(code);
    if (!backup && !/^\d{6}$/.test(value)) {
      setError({
        message: "Enter the 6-digit code from your authenticator app.",
      });
      return;
    }
    if (backup && !value) {
      setError({ message: "Enter a backup code." });
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
    if (response?.ok) {
      // A revoked operator can still have TOTP on: only real operators go on
      // to the operator area (design §13e); everyone else goes home.
      const operator = await fetch("/api/operator/extension-requests")
        .then((check) => check.ok)
        .catch(() => false);
      router.push(
        operator
          ? next.startsWith("/operator")
            ? next
            : "/operator"
          : "/home",
      );
      router.refresh();
      return;
    }
    setBusy(false);
    const json = (await response
      ?.clone()
      .json()
      .catch(() => null)) as { code?: string; message?: string } | null;
    const retry = Number(response?.headers.get("x-retry-after"));
    const problem = verifyProblem(
      response?.status,
      json,
      window.location.origin,
      Number.isFinite(retry) ? retry : undefined,
    );
    if (problem.restart) {
      onRestart(problem.message);
      return;
    }
    if (problem.clear) setCode("");
    if (problem.waitSeconds)
      setWaitUntil(Date.now() + problem.waitSeconds * 1000);
    setError(problem);
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
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
        Enter your authentication code
      </h2>
      <p>Open your authenticator app and enter the 6-digit code for JobFlow.</p>
      {error ? (
        <p
          id="two-factor-error"
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {error.message}
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
          aria-describedby={error ? "two-factor-error" : undefined}
          className={CONTROL}
        />
      </div>
      <Button type="submit" disabled={busy || waitUntil > 0}>
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
        <code>pnpm operator enrol-code --user &lt;id&gt; --reset</code>), then
        set up two-factor again at /operator/mfa. Until then, the CLI does every
        operator task.
      </p>
    </form>
  );
}
