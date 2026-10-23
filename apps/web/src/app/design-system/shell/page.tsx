import type { Metadata } from "next";
import { type Role, ROLES } from "@jobflow/authz";
import { AppShell } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/states";
import { ROLE_LABELS, navLinksFor } from "@/server/shell";

export const metadata: Metadata = { title: "Shell preview · JobFlow" };

/** Static, labelled preview of the shell for each role (no data, no session). */
export default async function ShellPreview({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const requested = (await searchParams).role;
  const role: Role = ROLES.includes(requested as Role)
    ? (requested as Role)
    : "owner";
  return (
    <AppShell
      companyName="Sample Company A"
      roleLabel={ROLE_LABELS[role]}
      navigation={navLinksFor(role)}
      demoPresent
      preview
    >
      <PageHeader
        title="Shell preview"
        description={`Navigation as a ${ROLE_LABELS[role].toLowerCase()} sees it.`}
        breadcrumbs={[
          { label: "Design system", href: "/design-system" },
          { label: "Shell" },
        ]}
      />
      <nav aria-label="Preview role" className="flex flex-wrap gap-2">
        {ROLES.map((r) => (
          <a
            key={r}
            href={`?role=${r}`}
            aria-current={r === role ? "page" : undefined}
            className="underline"
          >
            {ROLE_LABELS[r]}
          </a>
        ))}
      </nav>
      <EmptyState
        title="No records"
        description="Modules arrive milestone by milestone. This preview shows layout only."
      />
    </AppShell>
  );
}
