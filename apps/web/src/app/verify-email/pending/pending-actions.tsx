"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Resend for the signed-in, unverified user, and sign out (S3 AC4). */
export function PendingActions() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function resend() {
    const response = await fetch("/api/account/verification/resend-mine", {
      method: "POST",
    }).catch(() => undefined);
    const result = (await response?.json().catch(() => null)) as {
      status?: string;
      retryAfterSeconds?: number;
    } | null;
    if (result?.status === "already-verified") {
      router.push("/home");
      router.refresh();
      return;
    }
    setMessage(
      response?.status === 202
        ? "A new link is on its way. Check your inbox and spam folder."
        : response?.status === 429
          ? `You can request another link in ${Math.ceil((result?.retryAfterSeconds ?? 60) / 60)} minute(s).`
          : "Something went wrong. Try again.",
    );
  }

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" }).catch(
      () => undefined,
    );
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {message ? <p role="status">{message}</p> : null}
      <div className="flex flex-wrap gap-4">
        <Button type="button" onClick={() => void resend()}>
          Resend email
        </Button>
        <Button type="button" variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
