import { HttpError } from "../http/guards";
import type { CompanyAccess } from "../auth/actor";

// ADR 0004 D4, route layer (#222). The database guard at commit is
// authoritative; this gives a fast, clear 403 before any work is done.

/** Unsafe methods a read-only company can't use, unless allowed below. */
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
  error:
    "This company's trial has ended, so it's read-only. You can still view and export everything.",
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
  if (!UNSAFE_METHODS.has(upper)) return true;
  return ALLOWED.some(
    (entry) => entry.method === upper && entry.pattern.test(pathname),
  );
}

/** The SQLSTATE 55000 `jobflow_company_read_only` error from the commit-time guard. */
export function isCompanyReadOnlyError(error: unknown): boolean {
  const visited = new WeakSet<object>();
  const inspect = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    const row = value as Record<string, unknown>;
    const state = row.code ?? row.originalCode;
    if (
      state === "55000" &&
      [row.message, row.originalMessage].some(
        (message) =>
          typeof message === "string" &&
          message.includes("jobflow_company_read_only"),
      )
    )
      return true;
    if (depth === 5) return false;
    return [row.meta, row.cause, row.driverAdapterError].some((child) =>
      inspect(child, depth + 1),
    );
  };
  return inspect(error, 0);
}

/** For server actions that write company data: refuse while read-only. */
export function requireWritableActor(access: CompanyAccess | undefined): void {
  if (access?.readOnly) throw new HttpError(403, READ_ONLY_RESPONSE.error);
}
