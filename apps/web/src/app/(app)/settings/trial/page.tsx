import { can } from "@jobflow/authz";
import { addDays } from "@jobflow/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { shortDate, trialIndicatorText } from "@/components/shell/banners";
import { StatusPill } from "@/components/status-pill";
import { getDatabase } from "@/server/auth";
import { requireActor } from "@/server/authz";
import { ownerRequests } from "@/server/trial/extension-requests";
import { loadTrialStatus } from "@/server/trial/handlers";
import { sydneyDateTime } from "./format";
import { RequestExtension } from "./request-extension";

export const metadata: Metadata = { title: "Trial · JobFlow" };
export const dynamic = "force-dynamic";

const CARD = "space-y-3 rounded-lg border bg-card p-6 text-card-foreground";

/**
 * Trial status, extension requests and history (#232, S14, design §12).
 * Owners, managers and accountants (`trial.read`); only owners can ask for
 * more time or see past requests, as the API enforces. Others get the 404.
 */
export default async function TrialSettingsPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "trial.read")) notFound();
  const db = getDatabase();
  const trial = await loadTrialStatus(db, actor.companyId);
  const owner = can(actor.role, "trial.request_extension");
  const email = (
    <a
      className="font-semibold underline [overflow-wrap:anywhere]"
      href={`mailto:${trial.supportEmail}`}
    >
      {trial.supportEmail}
    </a>
  );
  const header = (
    <PageHeader
      title="Trial"
      description="Your free trial and requests for more time."
      breadcrumbs={[
        { label: "JobFlow", href: "/home" },
        { label: "Settings", href: "/settings" },
        { label: "Trial" },
      ]}
    />
  );
  if (trial.mode !== "trial" || !trial.lastDay || !trial.phase) {
    return (
      <>
        {header}
        <p>This company isn&apos;t on a trial.</p>
      </>
    );
  }
  const status = {
    phase: trial.phase,
    daysRemaining: trial.daysRemaining ?? 0,
  };
  const requests = owner ? await ownerRequests(db, actor.companyId) : null;
  return (
    <>
      {header}
      <section aria-labelledby="trial-status-heading" className={CARD}>
        <h2 id="trial-status-heading" className="text-xl font-semibold">
          Status
        </h2>
        <p className="flex flex-wrap items-center gap-3">
          <StatusPill
            status={
              trial.phase === "normal"
                ? "active"
                : trial.phase === "warning"
                  ? "pending"
                  : "overdue"
            }
            label={trial.phase === "expired" ? "Read-only" : "Trial"}
          />
          <span>{trialIndicatorText(status, trial.lastDay)}</span>
        </p>
        <p className="text-muted-foreground">
          {trial.phase === "expired"
            ? `Read-only since 12:00 am on ${shortDate(addDays(trial.lastDay, 1))} (Sydney time). You can still view and export your records.`
            : `Trial ends ${shortDate(trial.lastDay)} · Read-only from 12:00 am on ${shortDate(addDays(trial.lastDay, 1))} (Sydney time)`}
        </p>
        {trial.extended ? <p>Extended</p> : null}
      </section>
      {owner && requests ? (
        <>
          <section aria-labelledby="trial-request-heading" className={CARD}>
            <h2 id="trial-request-heading" className="text-xl font-semibold">
              Request more time
            </h2>
            <RequestExtension
              supportEmail={trial.supportEmail}
              pending={requests.pending}
            />
          </section>
          <section aria-labelledby="trial-history-heading" className={CARD}>
            <h2 id="trial-history-heading" className="text-xl font-semibold">
              Past requests
            </h2>
            {requests.decisions.length === 0 ? (
              <p className="text-muted-foreground">No past requests.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="py-2 pr-4">
                        Requested
                      </th>
                      <th scope="col" className="py-2 pr-4">
                        Status
                      </th>
                      <th scope="col" className="py-2 pr-4">
                        Decided
                      </th>
                      <th scope="col" className="py-2">
                        Outcome
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.decisions.map((row) => (
                      <tr key={row.id} className="border-b align-top">
                        <td className="py-2 pr-4">
                          {sydneyDateTime(row.createdAt)}
                        </td>
                        <td className="py-2 pr-4">{statusLabel(row.status)}</td>
                        <td className="py-2 pr-4">
                          {row.decidedAt ? sydneyDateTime(row.decidedAt) : "—"}
                        </td>
                        <td className="py-2 [overflow-wrap:anywhere]">
                          {outcome(row)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <p>Only an owner can request more time. You can also email {email}.</p>
      )}
    </>
  );
}

const statusLabel = (status: string) =>
  ({
    approved: "Approved",
    declined: "Declined",
    closed: "Closed",
    pending: "Pending",
  })[status] ?? status;

/** The outcome text (design §12). The operator's note is never shown. */
function outcome(row: {
  status: string;
  newLastDay: string | null;
  reason: string | null;
  closedReason: string | null;
}) {
  switch (row.status) {
    case "approved":
      return row.newLastDay
        ? `Approved: extended to ${shortDate(row.newLastDay)}`
        : "Approved";
    case "declined":
      return row.reason ? `Declined: ${row.reason}` : "Declined";
    case "closed":
      return row.closedReason === "made_unrestricted"
        ? "Closed: no longer a trial"
        : "Closed: extended directly";
    default:
      return "Pending";
  }
}
