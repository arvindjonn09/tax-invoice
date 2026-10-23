/** Membership roles (docs/REQUIREMENTS.md). Mirrors the database enum. */
export type Role =
  "owner" | "manager" | "accountant" | "employee" | "subcontractor";

export const ROLES: readonly Role[] = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
];

/**
 * Every protected action, as `resource.action`. Adding a permission here does
 * NOT grant it to anyone: each role's list below must name it explicitly.
 */
export const PERMISSIONS = [
  "company.read",
  "company.update",
  "gst_settings.read",
  "gst_settings.update",
  "user.read",
  "user.manage",
  "audit.read",
  "customer.read",
  "customer.write",
  "job.read_all",
  "job.read_assigned",
  "job.write",
  "job.assign",
  "job.price.read",
  "job.profit.read",
  "employee.read",
  "employee.write",
  "employee.cost_rate.read",
  "timesheet.submit_own",
  "timesheet.approve",
  "contractor.read",
  "contractor.write",
  "offer.read_own",
  "offer.respond_own",
  "expense.submit_own",
  "expense.read_all",
  "expense.approve",
  "evidence.submit_assigned",
  "document.upload",
  "document.read_all",
  "quote.read",
  "quote.write",
  "invoice.read",
  "invoice.write",
  "invoice.issue",
  "bill.read",
  "bill.write",
  "bill.submit_own",
  "payment.read",
  "payment.write",
  "report.read",
  "gst_report.read",
  "export.run",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const OFFICE: readonly Permission[] = [
  "company.read",
  "document.upload",
  "document.read_all",
  "customer.read",
  "job.read_all",
  "job.price.read",
  "job.profit.read",
  "employee.read",
  "contractor.read",
  "expense.read_all",
  "quote.read",
  "invoice.read",
  "bill.read",
  "payment.read",
  "report.read",
];

/**
 * Role → explicitly granted permissions. Anything not listed is denied.
 * Employees and subcontractors get no price, profit, cost-rate or
 * company-wide financial permission (AGENTS.md; threat model T02/T03).
 */
const GRANTS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: [
    ...OFFICE,
    "customer.write",
    "job.write",
    "job.assign",
    "employee.write",
    "employee.cost_rate.read",
    "timesheet.approve",
    "contractor.write",
    "expense.approve",
    "quote.write",
    "user.read",
  ],
  accountant: [
    ...OFFICE,
    "gst_settings.read",
    "gst_settings.update",
    "invoice.write",
    "invoice.issue",
    "bill.write",
    "payment.write",
    "gst_report.read",
    "export.run",
    "audit.read",
  ],
  employee: [
    "company.read",
    "document.upload",
    "job.read_assigned",
    "timesheet.submit_own",
    "expense.submit_own",
    "evidence.submit_assigned",
  ],
  subcontractor: [
    "company.read",
    "document.upload",
    "job.read_assigned",
    "offer.read_own",
    "offer.respond_own",
    "bill.submit_own",
    "evidence.submit_assigned",
  ],
};

const MATRIX: ReadonlyMap<Role, ReadonlySet<Permission>> = new Map(
  ROLES.map((role) => [role, new Set(GRANTS[role])]),
);

/** Deny by default: unknown roles or permissions are never allowed. */
export function can(role: string, permission: string): boolean {
  return MATRIX.get(role as Role)?.has(permission as Permission) === true;
}

/** The permissions a role holds (e.g. to filter navigation). Server still enforces. */
export function permissionsOf(role: Role): Permission[] {
  return PERMISSIONS.filter((permission) => can(role, permission));
}
