"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Pick which company this session acts in; the server re-checks membership. */
export function CompanyChooser({
  companies,
  next = "/home",
}: {
  companies: { companyId: string; name: string; role: string }[];
  /** Already checked on the server (safeNextPath). */
  next?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function choose(companyId: string) {
    setPending(true);
    const response = await fetch("/api/session/company", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId }),
    }).catch(() => undefined);
    if (response?.ok) {
      router.push(next);
      router.refresh();
      return;
    }
    setPending(false);
    setError("We couldn't open that company. Try again.");
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          {error}
        </p>
      ) : null}
      <ul className="space-y-3">
        {companies.map((company) => (
          <li
            key={company.companyId}
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4"
          >
            <div>
              <p className="font-semibold">{company.name}</p>
              <p className="text-sm text-muted-foreground">{company.role}</p>
            </div>
            <Button
              type="button"
              disabled={pending}
              aria-label={`Open ${company.name}`}
              onClick={() => void choose(company.companyId)}
            >
              Open
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
