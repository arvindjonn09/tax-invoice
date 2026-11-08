"use client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="outline"
      onClick={async () => {
        await fetch("/api/auth/sign-out", { method: "POST" }).catch(
          () => undefined,
        );
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
