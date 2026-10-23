import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/states";
import { requireActor } from "@/server/authz";
import { NAV_ITEMS, navItemFor } from "@/server/navigation";

// Only known module slugs exist; any other path is a 404 before any auth or
// database work runs.
export const dynamicParams = false;
export function generateStaticParams() {
  return NAV_ITEMS.map((item) => ({ module: item.slug }));
}

/**
 * Placeholder for modules not built yet. Unknown modules, and modules this
 * role can't use, are 404s so they can't be probed. No sample data is shown.
 */
export default async function ModulePage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const [{ module }, actor] = await Promise.all([
    params,
    requireActor("company.read"),
  ]);
  const item = navItemFor(actor.role, module);
  if (!item) notFound();
  return (
    <>
      <PageHeader
        title={item.label}
        breadcrumbs={[
          { label: "JobFlow", href: "/home" },
          { label: item.label },
        ]}
      />
      <EmptyState
        title={`${item.label} is on its way`}
        description={`This module is delivered in milestone ${item.milestone}. Nothing here is real data yet.`}
      />
    </>
  );
}
