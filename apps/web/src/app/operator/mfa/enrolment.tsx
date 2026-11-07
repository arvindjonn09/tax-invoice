"use client";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { encode } from "uqr";
import { Button } from "@/components/ui/button";
import { cleanCode } from "@/app/login/two-factor-step";

/** ENROLMENT_CODE_HEADER in server/operator/access.ts (a test keeps them equal). */
export const ENROLMENT_HEADER = "x-jobflow-enrolment-code";

const CONTROL =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";

type Step =
  | { kind: "code" }
  | { kind: "app"; uri: string; secret: string; backupCodes: string[] }
  | { kind: "backup"; backupCodes: string[] }
  | { kind: "done" };

/** The secret from an otpauth:// URI, in groups of four for typing. */
export function secretFrom(uri: string) {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return secret.match(/.{1,4}/g)?.join(" ") ?? "";
}

/** A QR code drawn as SVG rectangles: no HTML injection, no network. */
function QrCode({ value }: { value: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 2 });
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={`0 0 ${size} ${size}`}
      className="size-56 bg-white"
      shapeRendering="crispEdges"
    >
      {data.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill="#000"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

function Alert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-lg bg-danger p-4 text-danger-foreground">
      {message}
    </p>
  ) : null;
}

/** Enrolment code → authenticator app → backup codes → done (§13d). */
export function Enrolment() {
  const [step, setStep] = useState<Step>({ kind: "code" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get("enrolmentCode") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!code || !password) {
      setError(!code ? "Enter your enrolment code." : "Enter your password.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth/two-factor/enable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ENROLMENT_HEADER]: code,
      },
      body: JSON.stringify({ password }),
    }).catch(() => undefined);
    setBusy(false);
    const result = (await response?.json().catch(() => null)) as {
      totpURI?: string;
      backupCodes?: string[];
      code?: string;
    } | null;
    if (response?.ok && result?.totpURI && result.backupCodes) {
      setStep({
        kind: "app",
        uri: result.totpURI,
        secret: secretFrom(result.totpURI),
        backupCodes: result.backupCodes,
      });
      return;
    }
    setError(
      response?.status === 403
        ? "That code is invalid or has expired."
        : result?.code === "INVALID_PASSWORD"
          ? "That password is incorrect."
          : result?.code === "TOTP_ALREADY_ENABLED"
            ? "Two-factor authentication is already on. Ask for a new enrolment code to set it up again."
            : "Something went wrong. Try again.",
    );
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== "app") return;
    const code = cleanCode(totp);
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) {
      setStep({ kind: "backup", backupCodes: step.backupCodes });
      return;
    }
    setTotp("");
    setError("That code didn't work. Check your app and try the newest code.");
  }

  if (step.kind === "done")
    return (
      <>
        <h1
          ref={(node) => node?.focus()}
          tabIndex={-1}
          className="text-3xl font-bold tracking-tight"
        >
          Two-factor authentication is on.
        </h1>
        <p>
          <Link
            href="/operator"
            className="inline-flex min-h-11 items-center font-semibold underline"
          >
            Go to the operator area
          </Link>
        </p>
      </>
    );

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">
        Set up two-factor authentication
      </h1>
      <Alert message={error} />
      {step.kind === "code" ? (
        <form
          onSubmit={start}
          noValidate
          className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
        >
          <h2 className="text-xl font-semibold">
            Step 1: Enter your enrolment code
          </h2>
          <div className="flex flex-col gap-2">
            <label htmlFor="enrolment-code">Enrolment code</label>
            <p
              id="enrolment-code-help"
              className="text-sm text-muted-foreground"
            >
              Ask for a code on the server:{" "}
              <code>pnpm operator enrol-code --user &lt;id&gt;</code>. Codes
              work once, for 10 minutes.
            </p>
            <input
              id="enrolment-code"
              name="enrolmentCode"
              autoComplete="off"
              aria-describedby="enrolment-code-help"
              className={CONTROL}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="enrolment-password">Your password</label>
            <input
              id="enrolment-password"
              name="password"
              type="password"
              autoComplete="current-password"
              className={CONTROL}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Checking…" : "Continue"}
          </Button>
        </form>
      ) : null}
      {step.kind === "app" ? (
        <form
          onSubmit={confirm}
          noValidate
          className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
        >
          <h2
            ref={(node) => node?.focus()}
            tabIndex={-1}
            className="text-xl font-semibold"
          >
            Step 2: Add JobFlow to your authenticator app
          </h2>
          <p>Scan this code, or type the key below into your app.</p>
          <QrCode value={step.uri} />
          <div className="flex flex-wrap items-center gap-3">
            <p>
              Key: <code className="font-mono text-lg">{step.secret}</code>
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(step.secret.replace(/\s/g, ""))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              Copy
            </Button>
            <span role="status" className="text-sm">
              {copied ? "Key copied." : ""}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="enrolment-totp">Enter the 6-digit code</label>
            <input
              id="enrolment-totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(event) => setTotp(cleanCode(event.target.value))}
              className={CONTROL}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Verify"}
          </Button>
        </form>
      ) : null}
      {step.kind === "backup" ? (
        <section
          aria-labelledby="backup-heading"
          className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
        >
          <h2
            id="backup-heading"
            ref={(node) => node?.focus()}
            tabIndex={-1}
            className="text-xl font-semibold"
          >
            Step 3: Save your backup codes
          </h2>
          <p>
            Each code signs you in once if you lose your device. They won&apos;t
            be shown again.
          </p>
          <ul className="grid gap-2 font-mono sm:grid-cols-2">
            {step.backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const blob = new Blob([`${step.backupCodes.join("\n")}\n`], {
                type: "text/plain",
              });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = "jobflow-backup-codes.txt";
              link.click();
              URL.revokeObjectURL(link.href);
            }}
          >
            Download
          </Button>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              className="size-5"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            I&apos;ve saved these
          </label>
          <Button
            type="button"
            disabled={!saved}
            onClick={() => setStep({ kind: "done" })}
          >
            Finish
          </Button>
        </section>
      ) : null}
    </>
  );
}
