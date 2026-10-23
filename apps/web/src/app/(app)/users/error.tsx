"use client";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shell/states";
export default function UserAccessError({ reset }: { reset: () => void }) {
  return (
    <ErrorState
      title="User access is unavailable"
      message="Try loading this page again."
      retry={<Button onClick={reset}>Try again</Button>}
    />
  );
}
