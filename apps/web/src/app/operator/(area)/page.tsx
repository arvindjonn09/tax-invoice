import type { Metadata } from "next";
import Link from "next/link";
import {
  PHASE_LABEL,
  STATUS_LABEL,
  formatDay,
  formatInstant,
  operatorOutcome,
} from "@/components/operator/format";
import { Pager, pageFrom } from "@/components/operator/pager";
import { getDatabase } from "@/server/auth";
import { requireOperator } from "@/server/operator";
import {
  OPERATOR_PAGE_SIZE,
  countPendingRequests,
  loadRequests,
} from "@/server/operator/handlers";

export const metadata: Metadata = { title: "Extension requests · Operator" };
export const dynamic = "force-dynamic";

const TAB =
  "inline-flex min-h-11 items-center rounded-t-md border-b-2 px-4 font-semibold";

/** Extension requests: pending oldest first, or the last decisions (§13a). */
export default async function OperatorRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const params = await searchParams;
  const decided = params.status === "decided";
  const page = pageFrom(params.page);
  const db = getDatabase();
  const now = new Date();
  const [pendingCount, requests] = await Promise.all([
    countPendingRequests(db),
    loadRequests(db, { decided, page, now }),
  ]);
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">Extension requests</h1>
      <nav aria-label="Request status" className="flex gap-2 border-b">
        <Link
          href="/operator"
          aria-current={decided ? undefined : "page"}
          className={`${TAB} ${decided ? "border-transparent" : "border-current"}`}
        >
          Pending ({pendingCount})
        </Link>
        <Link
          href="/operator?status=decided"
          aria-current={decided ? "page" : undefined}
          className={`${TAB} ${decided ? "border-current" : "border-transparent"}`}
        >
          Decided
        </Link>
      </nav>
      {requests.length === 0 ? (
        <p>{decided ? "No decided requests yet." : "No pending requests."}</p>
      ) : (
        <div
          className="overflow-x-auto rounded-lg border bg-card"
          tabIndex={0}
          role="region"
          aria-label={
            decided ? "Decided requests table" : "Pending requests table"
          }
        >
          <table className="w-full min-w-[40rem] text-left">
            <caption className="sr-only">
              {decided ? "Decided requests" : "Pending requests"}
            </caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="p-3">
                  Requested
                </th>
                <th scope="col" className="p-3">
                  Company
                </th>
                <th scope="col" className="p-3">
                  Owner
                </th>
                <th scope="col" className="p-3">
                  Last day
                </th>
                <th scope="col" className="p-3">
                  {decided ? "Outcome" : "Phase"}
                </th>
                <th scope="col" className="p-3">
                  {decided ? (
                    "Operator"
                  ) : (
                    <span className="sr-only">Review</span>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.map((row) => (
                <tr key={row.id} className="border-b align-top">
                  <td className="p-3">{formatInstant(row.createdAt)}</td>
                  <td className="p-3 [overflow-wrap:anywhere]">
                    {row.company.name}
                  </td>
                  <td className="p-3 [overflow-wrap:anywhere]">
                    {row.owner.name}
                    <br />
                    <span className="text-sm text-muted-foreground">
                      {row.owner.email}
                    </span>
                  </td>
                  <td className="p-3">{formatDay(row.lastDayAtRequest)}</td>
                  <td className="p-3 [overflow-wrap:anywhere]">
                    {decided
                      ? `${STATUS_LABEL[row.status] ?? row.status} · ${operatorOutcome(row)}`
                      : row.company.phase
                        ? PHASE_LABEL[row.company.phase]
                        : "Not on a trial"}
                  </td>
                  <td className="p-3">
                    {decided ? (
                      <span className="[overflow-wrap:anywhere]">
                        {row.decidedByEmail ?? "—"}
                      </span>
                    ) : (
                      <Link
                        href={`/operator/requests/${row.id}`}
                        className="inline-flex min-h-11 items-center font-semibold underline"
                      >
                        Review
                        <span className="sr-only">
                          {" "}
                          the request from {row.company.name}
                        </span>
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        page={page}
        full={requests.length === OPERATOR_PAGE_SIZE}
        href={(n) =>
          decided ? `/operator?status=decided&page=${n}` : `/operator?page=${n}`
        }
      />
    </>
  );
}
