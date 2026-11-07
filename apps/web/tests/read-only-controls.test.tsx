import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanyAccessProvider } from "@/components/shell/company-access";
import { InvoiceList } from "@/features/invoices/list";
import { JobsDirectory } from "@/features/jobs/directory";
import { Directory as CustomerDirectory } from "@/features/customers/directory";
import { ProfileForm } from "@/app/(app)/settings/profile-form";

// #226 / S9 AC5: on a read-only company, create and edit controls stay
// visible but disabled, with a one-line reason. Roles that can't write never
// see them. Rendered on the server, so the data hooks never fetch.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const REASON = "Read-only: the trial has ended.";
const render = (readOnly: boolean, node: ReactNode) =>
  renderToStaticMarkup(
    <CompanyAccessProvider value={{ readOnly, reason: REASON }}>
      {node}
    </CompanyAccessProvider>,
  );

const profile = {
  name: "Sample Company A",
  legalName: null,
  abn: null,
  addressLine1: null,
  addressLine2: null,
  suburb: null,
  state: null,
  postcode: null,
  invoicePrefix: "INV",
  jobPrefix: "JOB",
};

const pages: Array<[string, string, (allowed: boolean) => ReactNode]> = [
  [
    "invoices",
    "New invoice",
    (allowed) => <InvoiceList canWrite={allowed} today="2026-11-06" />,
  ],
  [
    "jobs",
    "Create job",
    (allowed) => <JobsDirectory office editable={allowed} />,
  ],
  [
    "customers",
    "Add customer",
    (allowed) => <CustomerDirectory editable={allowed} />,
  ],
];

describe("read-only controls (S9 AC5)", () => {
  it.each(pages)(
    "%s: the primary action is a working control while writable",
    (_page, label, page) => {
      const html = render(false, page(true));
      expect(html).toContain(label);
      expect(html).not.toContain('aria-disabled="true"');
      expect(html).not.toContain(REASON);
    },
  );

  it.each(pages)(
    "%s: read-only keeps it visible, aria-disabled and described by the reason",
    (_page, label, page) => {
      const html = render(true, page(true));
      const button = new RegExp(
        `<button[^>]*aria-disabled="true"[^>]*aria-describedby="([^"]+)"[^>]*>${label}</button>`,
      ).exec(html);
      expect(button, html).not.toBeNull();
      expect(html).toContain(`id="${button![1]}"`);
      expect(html).toContain(REASON);
      // No live link or handler-bearing create control remains.
      expect(html).not.toContain('href="/invoices/new"');
    },
  );

  it.each(pages)(
    "%s: a role that can't write sees no action and no reason",
    (_page, label, page) => {
      const html = render(true, page(false));
      expect(html).not.toContain(label);
      expect(html).not.toContain(REASON);
    },
  );

  it("settings: the company form is disabled with the reason on a read-only company", () => {
    const writable = render(false, <ProfileForm profile={profile} editable />);
    expect(writable).not.toMatch(/<fieldset[^>]*disabled/);
    const readOnly = render(true, <ProfileForm profile={profile} editable />);
    expect(readOnly).toMatch(/<fieldset[^>]*disabled/);
    expect(readOnly).toContain(REASON);
    // A role without edit rights already gets a disabled form, and no reason.
    expect(
      render(true, <ProfileForm profile={profile} editable={false} />),
    ).not.toContain(REASON);
  });
});
