import { type Permission, type Role, can } from "@jobflow/authz";

export type NavItem = {
  /** URL segment under the app, e.g. "jobs" → /jobs. */
  slug: string;
  label: string;
  /** Short text icon (decorative; the label is always visible or announced). */
  icon: string;
  /** Shown when the role holds ANY of these permissions. */
  anyOf: readonly Permission[];
  /** Milestone that delivers the module; shown on its placeholder page. */
  milestone: string;
  /** Restrict to these roles (e.g. "My offers" is a subcontractor view). */
  onlyRoles?: readonly Role[];
};

/**
 * The app's modules in display order. Visibility here is a convenience only:
 * every page and route still enforces its own permission on the server.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    slug: "dashboard",
    label: "Dashboard",
    icon: "◧",
    anyOf: ["report.read"],
    milestone: "M4",
  },
  {
    slug: "jobs",
    label: "Jobs",
    icon: "▤",
    anyOf: ["job.read_all", "job.read_assigned"],
    milestone: "M1",
  },
  {
    slug: "customers",
    label: "Customers",
    icon: "◍",
    anyOf: ["customer.read"],
    milestone: "M1",
  },
  {
    slug: "quotes",
    label: "Quotes",
    icon: "✎",
    anyOf: ["quote.read"],
    milestone: "M3",
  },
  {
    slug: "invoices",
    label: "Invoices",
    icon: "▦",
    anyOf: ["invoice.read"],
    milestone: "M3",
  },
  {
    slug: "payments",
    label: "Payments",
    icon: "⇄",
    anyOf: ["payment.read"],
    milestone: "M3",
  },
  {
    slug: "expenses",
    label: "Expenses",
    icon: "◔",
    anyOf: ["expense.read_all", "expense.submit_own"],
    milestone: "M2",
  },
  {
    slug: "timesheets",
    label: "Timesheets",
    icon: "◷",
    anyOf: ["timesheet.approve", "timesheet.submit_own"],
    milestone: "M2",
  },
  {
    slug: "employees",
    label: "Employees",
    icon: "☺",
    anyOf: ["employee.read"],
    milestone: "M1",
  },
  {
    slug: "contractors",
    label: "Contractors",
    icon: "⚒",
    anyOf: ["contractor.read"],
    milestone: "M2",
  },
  {
    slug: "offers",
    label: "My offers",
    icon: "✉",
    anyOf: ["offer.read_own"],
    milestone: "M2",
    onlyRoles: ["subcontractor"],
  },
  {
    slug: "reports",
    label: "Reports",
    icon: "▥",
    anyOf: ["report.read", "gst_report.read"],
    milestone: "M4",
  },
  {
    slug: "users",
    label: "User access",
    icon: "♙",
    anyOf: ["user.manage"],
    milestone: "M1",
  },
  {
    slug: "settings",
    label: "Settings",
    icon: "⚙",
    anyOf: ["company.update", "gst_settings.read", "user.manage"],
    milestone: "M1",
  },
];

/** Navigation for a role, in display order. */
export function navigationFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter(
    (item) =>
      (!item.onlyRoles || item.onlyRoles.includes(role)) &&
      item.anyOf.some((permission) => can(role, permission)),
  );
}

/** The nav item for a URL segment, only if this role may see it. */
export function navItemFor(role: Role, slug: string): NavItem | undefined {
  return navigationFor(role).find((item) => item.slug === slug);
}

/** Where to land after sign-in: the first module the role can open. */
export function homeFor(role: Role): string {
  return `/${navigationFor(role)[0]?.slug ?? "account"}`;
}
