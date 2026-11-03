# Authorisation

How every request is authenticated, scoped to a company and checked before it touches data (#14). Authentication itself is [ADR 0003](../adr/0003-authentication.md).

## The rule

**Deny by default. The server decides who, which company and what; the client never does.**

1. `resolveActor()` (`apps/web/src/server/auth/actor.ts`) reads the session cookie and loads the user's **active memberships** from the database. The company and role come from there, never from request input.
2. `can(role, permission)` (`packages/authz/src/policy.ts`) checks an explicit role → permission list. Unknown roles or permissions are denied. Adding a permission grants it to nobody until a role lists it.
3. Queries are scoped with `companyScope(actor, where)`, which **overwrites** any `companyId` in input with the actor's company.
4. Single records are checked with `requireSameCompany(actor, record)` (or `requireOwnCompany` for the company row). Another company's record returns **404 Not found**, the same as a missing one, so tenant ids can't be probed.
5. Responses are projected with `visibleFields(actor, record, rules)`. This is a **positive allowlist**: fields not listed are never returned, and fields tied to a permission (e.g. `job.price.read`, `job.profit.read`) are only returned to roles holding it.

## Route handlers and server actions

```ts
// apps/web/src/app/api/company/route.ts
export const GET = withPolicy("company.read", handlers.read);
export const PATCH = withPolicy("company.update", handlers.rename);
```

- `withPolicy(permission, handler)` resolves the actor and enforces the permission before the handler runs. It returns `401` when signed out, `403` without an active company or permission, and `404` for other tenants' objects. All responses are `Cache-Control: private, no-store`.
- Server components and actions call `await requireActor("permission")`.
- **Guard:** `tests/unit/route-policy.test.ts` fails CI if any `route.ts` exports a handler not created by `withPolicy`, or any `"use server"` file doesn't call `requireActor(`. Public exceptions (`api/health`, `api/auth/[...all]`) and policy-free actions (sign-out) are listed there with a reason.

## Roles

| Role | Can | Never |
|---|---|---|
| owner | everything | — |
| manager | customers, jobs, assignments, employees (incl. cost rates), contractors, approvals, quotes; read finance and profit | issue invoices, GST settings, manage users |
| accountant | invoices (incl. issue), bills, payments, GST settings and reports, exports, audit log; read jobs and profit | assign work, manage users |
| employee | own company name; **assigned** jobs; submit own timesheets, expenses, evidence | prices, profit, cost rates, customers, company-wide finance |
| subcontractor | own company name; **assigned** jobs; own offers and bills; evidence | prices, profit, other contractors, customers, company-wide finance |

The full list is in `packages/authz/src/policy.ts`, and `packages/authz/test/authz.test.ts` pins the restrictions above.

## Assignment-scoped access (later issues)

`job.read_assigned`, `offer.read_own` and similar permissions grant the *kind* of access only. The matching queries must also filter by assignment or ownership (#32, #37) and project through `visibleFields`. A permission check alone is never enough for employee or subcontractor data.

## Read-only companies (#222, ADR 0004 D4)

A trial company is read-only from `read_only_from`, which is Sydney midnight after its last trial day. Enforcement has two layers. The database layer is authoritative.

1. **Route guard.** `withPolicy` gets the company's access from `resolveActor` (`actor.access.readOnly`, judged by the database clock in the same query as the membership; #221). For a read-only company it refuses every unsafe method (POST, PUT, PATCH, DELETE) with `403 { error, code: "company_read_only" }` before the handler runs. The only exceptions are the routes in `READ_ONLY_ALLOWED` (`apps/web/src/server/authz/read-only.ts`), each with a reason:
   - `POST /api/documents/[id]/link`: a download link for an existing record;
   - `POST /api/invoices/[id]/pdf`: the PDF of an already-issued document;
   - `PATCH /api/users/[id]`: deactivation only (a role change is refused at the database);
   - `DELETE /api/users/invitations/[id]`: revoking an invitation.

   Safe methods (GET, including every export) are never blocked. Server actions that write company data call `requireWritableActor()`. A new unsafe route is guarded by default; `tests/unit/read-only.test.ts` pins the allowlist, and `tests/integration/read-only-guard.test.ts` sends every unsafe route through `withPolicy` for an expired company.
2. **Commit-time database guard.** `audit_events_company_writable` refuses the commit of any audited write for a read-only company (SQLSTATE `55000`, `jobflow_company_read_only`; see DATA_MODEL.md). `withPolicy` and the invitation-accept handler map that error to the same 403, which covers a write that started before expiry and commits after it. A handler opts a transaction in with `withAudit(db, work, { readOnlyExemption })`. The database admits only that key's actions (`READ_ONLY_EXEMPTION_ACTIONS`, kept equal to the SQL map by a parity test):
   - `export`: company and report exports;
   - `record_rendering`: issued-invoice PDFs;
   - `access_removal`: a pure deactivation and invitation revoke;
   - `invitation_pre_expiry`: accepting an invitation issued **before** `read_only_from`. One issued later is refused (S12 AC2);
   - `trial_extension_request`: the owner's request (S14);
   - `operator`: operator trial actions (#230);
   - `housekeeping`: document cleanup.

**Housekeeping that keeps running while read-only (S9 AC7):** `documents:cleanup` (declares `housekeeping`), the email outbox sweep, and trial reminders. The sweep and reminders write no company audit event, so the guard doesn't apply to them. No other background job writes company records.
