import { sydneyDate } from "@jobflow/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  PHASE_LABEL,
  formatDay,
  formatInstant,
} from "@/components/operator/format";
import { getDatabase } from "@/server/auth";
import { requireOperator } from "@/server/operator";
import { loadCompany } from "@/server/operator/handlers";
import { CompanyForms } from "./company-forms";

export const metadata: Metadata = { title: "Company · Operator" };
export const dynamic = "force-dynamic";

/** A company's trial and access, with direct changes (design §13c). */
export default async function OperatorCompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperator();
  const now = new Date();
  const company = await loadCompany(getDatabase(), (await params).id, now);
  if (!company) notFound();
  return (
    <>
      <p>
        <Link
          href="/operator/companies"
          className="inline-flex min-h-11 items-center font-semibold underline"
        >
          Back to companies
        </Link>
      </p>
      <h1 className="text-3xl font-bold tracking-tight [overflow-wrap:anywhere]">
        {company.name}
      </h1>
      <dl className="grid gap-x-6 gap-y-3 rounded-lg border bg-card p-6 text-card-foreground sm:grid-cols-[12rem_1fr]">
        <dt className="font-semibold">Created</dt>
        <dd>{formatInstant(company.createdAt)}</dd>
        <dt className="font-semibold">Access</dt>
        <dd>
          {company.mode === "trial" && company.phase
            ? `Trial · ${PHASE_LABEL[company.phase]}`
            : "Unrestricted"}
        </dd>
        <dt className="font-semibold">Last day</dt>
        <dd>{formatDay(company.lastDay)}</dd>
      </dl>
      <CompanyForms
        companyId={company.id}
        companyName={company.name}
        mode={company.mode}
        lastDay={company.lastDay}
        today={sydneyDate(now)}
      />
    </>
  );
}
