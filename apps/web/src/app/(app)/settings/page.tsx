import { can } from "@jobflow/authz";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { getDatabase } from "@/server/auth";
import { requireActor } from "@/server/authz";
import { sydneyToday, toDay } from "@/server/company/gst";
import { navItemFor } from "@/server/navigation";
import { gstStatusOn } from "@jobflow/domain";
import { type GstSettings, GstSettingsPanel } from "./gst-settings";
import { type Profile, ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Settings · JobFlow" };
export const dynamic = "force-dynamic";

/**
 * Company profile, numbering and GST settings (#26). Owners edit the
 * profile; owners and accountants manage GST. Everyone else gets a 404, like
 * any module they can't use. The APIs enforce the same rules.
 */
export default async function SettingsPage() {
  const actor = await requireActor("company.read");
  if (!navItemFor(actor.role, "settings")) notFound();
  const canSeeTax = can(actor.role, "gst_settings.read");
  const db = getDatabase();
  const [company, rows] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: actor.companyId } }),
    canSeeTax
      ? db.companyGstRegistration.findMany({
          where: { companyId: actor.companyId },
          orderBy: { startsOn: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const profile: Profile = {
    name: company.name,
    legalName: company.legalName,
    abn: company.abn,
    addressLine1: company.addressLine1,
    addressLine2: company.addressLine2,
    suburb: company.suburb,
    state: company.state,
    postcode: company.postcode,
    invoicePrefix: company.invoicePrefix,
    jobPrefix: company.jobPrefix,
  };
  const registrations = rows.map((row) => ({
    id: row.id,
    startsOn: toDay(row.startsOn),
    endsOn: row.endsOn ? toDay(row.endsOn) : null,
    basis: row.basis,
  }));
  const today = sydneyToday();
  const gst: GstSettings = {
    basPeriod: company.basPeriod,
    registrations,
    today: { date: today, ...gstStatusOn(registrations, today) },
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="Company details, numbering and GST registration."
        breadcrumbs={[
          { label: "JobFlow", href: "/home" },
          { label: "Settings" },
        ]}
      />
      {canSeeTax ? (
        <>
          <section
            aria-labelledby="company-heading"
            className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
          >
            <h2 id="company-heading" className="text-xl font-semibold">
              Company details
            </h2>
            <ProfileForm
              profile={profile}
              editable={can(actor.role, "company.update")}
            />
          </section>
          <section
            aria-labelledby="gst-heading"
            className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
          >
            <h2 id="gst-heading" className="text-xl font-semibold">
              GST
            </h2>
            <GstSettingsPanel
              settings={gst}
              editable={can(actor.role, "gst_settings.update")}
            />
          </section>
        </>
      ) : (
        <p className="text-muted-foreground">
          Company and GST settings are managed by the owner and accountant.
        </p>
      )}
    </>
  );
}
