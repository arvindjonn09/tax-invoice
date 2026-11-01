import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { sydneyToday } from "@/server/company/gst";
import { ReportsHub, type ReportView } from "@/features/reports/hub";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports · JobFlow" };

/** Each view needs its own permission; the API checks it again. */
const NEEDS: Record<ReportView, Parameters<typeof can>[1]> = {
  profitability: "job.profit.read",
  gst: "gst_report.read",
  ageing: "ledger_report.read",
  cash: "ledger_report.read",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const actor = await requireActor("company.read");
  const views = (Object.keys(NEEDS) as ReportView[]).filter((view) =>
    can(actor.role, NEEDS[view]),
  );
  if (!views.length) notFound();
  const { view } = await searchParams;
  const current = views.find((item) => item === view) ?? views[0]!;
  return (
    <ReportsHub
      key={current}
      views={views}
      view={current}
      today={sydneyToday()}
      canExport={can(actor.role, "export.run")}
    />
  );
}
