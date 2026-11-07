import type { Metadata } from "next";
import Link from "next/link";
import {
  PHASE_LABEL,
  formatDay,
  formatInstant,
} from "@/components/operator/format";
import { Button } from "@/components/ui/button";
import { Pager, pageFrom } from "@/components/operator/pager";
import { getDatabase } from "@/server/auth";
import { requireOperator } from "@/server/operator";
import { OPERATOR_PAGE_SIZE, loadCompanies } from "@/server/operator/handlers";

export const metadata: Metadata = { title: "Companies · Operator" };
export const dynamic = "force-dynamic";

/** Search companies by name; demo companies are never listed (§13c). */
export default async function OperatorCompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const params = await searchParams;
  const raw = params.q;
  const page = pageFrom(params.page);
  const q = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 200) ?? "";
  const companies = await loadCompanies(getDatabase(), {
    q,
    page,
    now: new Date(),
  });
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">Companies</h1>
      <form
        method="get"
        role="search"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="company-search">Company name</label>
          <input
            id="company-search"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={200}
            className="min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground"
          />
        </div>
        <Button type="submit">Search</Button>
      </form>
      {companies.length === 0 ? (
        <p>No companies match.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {companies.map((company) => (
            <li
              key={company.id}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div className="min-w-0">
                <Link
                  href={`/operator/companies/${company.id}`}
                  className="inline-flex min-h-11 items-center font-semibold underline [overflow-wrap:anywhere]"
                >
                  {company.name}
                </Link>
                <p className="text-sm text-muted-foreground">
                  Created {formatInstant(company.createdAt)}
                </p>
              </div>
              <p>
                {company.mode === "trial" && company.phase
                  ? `${PHASE_LABEL[company.phase]} · last day ${formatDay(company.lastDay)}`
                  : "Unrestricted"}
              </p>
            </li>
          ))}
        </ul>
      )}
      <Pager
        page={page}
        full={companies.length === OPERATOR_PAGE_SIZE}
        href={(n) =>
          `/operator/companies?${new URLSearchParams({ q, page: String(n) })}`
        }
      />
    </>
  );
}
