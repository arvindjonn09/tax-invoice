"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";

const control =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  const result = (await response?.json().catch(() => null)) as {
    error?: string;
    lastDay?: string;
  } | null;
  return { ok: Boolean(response?.ok), result };
}

export function AdminLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const { ok, result } = await post("/api/admin-console/login", {
      username: form.get("username"),
      password: form.get("password"),
    });
    setPending(false);
    if (ok) {
      router.refresh();
      return;
    }
    setError(result?.error ?? "Sign-in failed");
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          className={control}
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={control}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export function AdminLogout() {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() =>
        void post("/api/admin-console/logout", {}).then(() => router.refresh())
      }
    >
      Sign out
    </Button>
  );
}

/** Licence actions for one organisation; each is audited on the server. */
export function OrganisationActions({
  companyId,
  name,
  licence,
}: {
  companyId: string;
  name: string;
  licence: "full" | "trial" | "trial_ended";
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [days, setDays] = useState("30");
  if (licence === "full") return null;

  async function act(body: Record<string, unknown>, confirmText: string) {
    if (!window.confirm(confirmText)) return;
    const { ok, result } = await post("/api/admin-console/organisations", {
      companyId,
      ...body,
    });
    setMessage(
      ok
        ? result?.lastDay
          ? `Trial now ends ${result.lastDay}`
          : "Full licence assigned"
        : (result?.error ?? "Action failed"),
    );
    if (ok) router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        onClick={() =>
          void act(
            { action: "assign_full_licence" },
            `Give ${name} a full licence? Its trial ends and access is unrestricted.`,
          )
        }
      >
        Assign full licence
      </Button>
      <label className="sr-only" htmlFor={`days-${companyId}`}>
        Days to extend {name}
      </label>
      <input
        id={`days-${companyId}`}
        type="number"
        min={1}
        max={365}
        value={days}
        onChange={(event) => setDays(event.target.value)}
        className={`${control} w-24`}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          void act(
            { action: "extend_trial", days: Number(days) },
            `Extend ${name}'s trial by ${days} days?`,
          )
        }
      >
        Extend trial
      </Button>
      {message ? (
        <span role="status" className="text-sm">
          {message}
        </span>
      ) : null}
    </div>
  );
}
