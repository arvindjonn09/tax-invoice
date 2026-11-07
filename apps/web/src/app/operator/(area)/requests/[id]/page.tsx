import { sydneyDate } from "@jobflow/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  PHASE_LABEL,
  STATUS_LABEL,
  formatDay,
  formatInstant,
  operatorOutcome,
} from "@/components/operator/format";
import { getDatabase } from "@/server/auth";
import { requireOperator } from "@/server/operator";
import { loadRequest } from "@/server/operator/handlers";
import { DecisionForms } from "./decision-forms";

export const metadata: Metadata = { title: "Extension request · Operator" };
export const dynamic = "force-dynamic";

/** One extension request and its decision (design §13b). */
export default async function OperatorRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperator();
  const now = new Date();
  const request = await loadRequest(getDatabase(), (await params).id, now);
  if (!request) notFound();
  const { company } = request;
  const rows: [string, React.ReactNode][] = [
    ["Company", company.name],
    ["Created", formatInstant(company.createdAt)],
    [
      "Trial state",
      company.mode === "trial" && company.phase
        ? PHASE_LABEL[company.phase]
        : "Not on a trial",
    ],
    ["Last day", formatDay(company.lastDay)],
    ["Owner", request.owner.name],
    ["Owner email", request.owner.email],
    ["Requested", formatInstant(request.createdAt)],
    [
      "Message",
      request.message ? (
        <span className="whitespace-pre-wrap">{request.message}</span>
      ) : (
        "None"
      ),
    ],
    ["Status", STATUS_LABEL[request.status] ?? request.status],
  ];
  if (request.status !== "pending") {
    rows.push(
      ["Decided", formatInstant(request.decidedAt)],
      ["Outcome", operatorOutcome(request)],
      ["Operator", request.decidedByEmail ?? "—"],
    );
  }
  return (
    <>
      <p>
        <Link
          href="/operator"
          className="inline-flex min-h-11 items-center font-semibold underline"
        >
          Back to extension requests
        </Link>
      </p>
      <h1 className="text-3xl font-bold tracking-tight [overflow-wrap:anywhere]">
        Request from {company.name}
      </h1>
      <dl className="grid gap-x-6 gap-y-3 rounded-lg border bg-card p-6 text-card-foreground sm:grid-cols-[12rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-semibold">{label}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {request.status === "pending" ? (
        <DecisionForms
          requestId={request.id}
          companyName={company.name}
          lastDay={company.lastDay ?? request.lastDayAtRequest}
          today={sydneyDate(now)}
        />
      ) : null}
    </>
  );
}
