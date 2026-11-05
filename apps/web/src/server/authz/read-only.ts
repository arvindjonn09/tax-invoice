import { hasDatabaseError } from "../http/database-errors";

// ADR 0004 D4, route layer (#222). The database guard at commit is
// authoritative; this gives a fast, clear 403 before any work is done.

/** Methods that never change data: never blocked (an allowlist, so an
 * unexpected verb is treated as unsafe). Same set as http/guards.ts. */
export const SAFE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);
/** The unsafe methods route handlers export (for the route matrix tests). */
export const UNSAFE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * `"METHOD /api/path"` → why it stays allowed while read-only. Every other
 * unsafe company route is refused. The handler still passes its exemption
 * key, and the database admits only that key's audit actions.
 */
export const READ_ONLY_ALLOWED: Readonly<Record<string, string>> = {
  "POST /api/company/trial/extension-requests":
    "An owner asking for more time, which is how a read-only company gets out of it (trial_extension_request).",
  "POST /api/documents/[id]/link":
    "A download link for an existing record: no data changes.",
  "POST /api/invoices/[id]/pdf":
    "The PDF of an already-issued invoice or credit note (record_rendering).",
  "PATCH /api/users/[id]":
    "Membership deactivation only (access_removal); a role change is refused at the database.",
  "DELETE /api/users/invitations/[id]":
    "Revoking an invitation removes access (access_removal).",
};

export const READ_ONLY_RESPONSE = {
  // Role-neutral: workers can't export, and S8 AC2 shows them no trial details.
  error: "This company's account is read-only, so this change can't be saved.",
  code: "company_read_only",
} as const;

function templatePattern(template: string): RegExp {
  const escaped = template
    .split("/")
    .map((part) =>
      /^\[[^\]]+\]$/.test(part)
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${escaped}$`);
}
const ALLOWED = Object.keys(READ_ONLY_ALLOWED).map((key) => {
  const [method, template] = key.split(" ") as [string, string];
  return { method, pattern: templatePattern(template) };
});

/** Is `method pathname` allowed for a read-only company? */
export function allowedWhileReadOnly(
  method: string,
  pathname: string,
): boolean {
  const upper = method.toUpperCase();
  if (SAFE_METHODS.has(upper)) return true;
  return ALLOWED.some(
    (entry) => entry.method === upper && entry.pattern.test(pathname),
  );
}

/** The SQLSTATE 55000 `jobflow_company_read_only` error from the commit-time guard. */
export function isCompanyReadOnlyError(error: unknown): boolean {
  return hasDatabaseError(error, "55000", "jobflow_company_read_only");
}
