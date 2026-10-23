import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { PreviewShell } from "@/components/preview/preview-shell";

export const metadata: Metadata = { title: "Design previews · JobFlow" };

export default function DesignPreviews() {
  return (
    <PreviewShell>
      <PageHeader
        title="Design previews"
        description="Static M0 layouts for owner review. No data, no calculations, no actions."
      />
      <ul className="list-disc space-y-2 pl-6">
        <li>
          <Link className="underline" href="/design-previews/dashboard">
            Dashboard
          </Link>{" "}
          — sample values, loading, empty and error states
        </li>
        <li>
          <Link className="underline" href="/design-previews/invoice-builder">
            Invoice builder
          </Link>{" "}
          — registered, mixed-code and unregistered specimens
        </li>
        <li>
          <Link className="underline" href="/design-system/shell">
            App shell by role
          </Link>
        </li>
        <li>
          <Link className="underline" href="/design-system">
            Design system foundations
          </Link>
        </li>
      </ul>
    </PreviewShell>
  );
}
