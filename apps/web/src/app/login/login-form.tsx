"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";

type State =
  { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

// Posts to Better Auth's HTTP endpoint so origin checks and sign-in throttling apply.
export function LoginForm() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState({ kind: "pending" });
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    }).catch(() => undefined);
    if (response?.ok) {
      router.push("/account");
      router.refresh();
      return;
    }
    setState({
      kind: "error",
      message:
        response?.status === 429
          ? "Too many sign-in attempts. Wait a minute and try again."
          : "Email or password is incorrect.",
    });
  }

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
      <div className="flex flex-col gap-2">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground"
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
          className="min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground"
        />
      </div>
      <Button type="submit" disabled={state.kind === "pending"}>
        {state.kind === "pending" ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
