# Pre-production security and permission audit (#61)

Performed on 2 November 2026 by Claude B, on `main` after #198 (pinned images), with #197 (late bill evidence) still open. This is an engineering audit with evidence. It is **not** a penetration test, and it does not sign off production use: the owner decides, after the open items below.

## Result

**No open Critical or High findings** in the application code reviewed. The open items are configuration and operations tasks for the staging/production host, and accepted deferrals.

## What was checked, and the evidence

| Area | Check | Evidence |
|---|---|---|
| **RBAC: every route** | Every API route method is wrapped in `withPolicy` with an explicit permission. The public exceptions each have a stated reason. | `tests/unit/route-policy.test.ts` |
| **RBAC: matrix** | The [route permission matrix](route-matrix.md) is generated from the code. CI fails if the code and the document drift apart. | `tests/unit/route-matrix.test.ts` |
| **Worker isolation** | Employees and subcontractors reach only worker-facing routes: `/api/my/*`, their own timesheets and expenses, uploads and the company header. They reach no price, cost, invoice, payment, report or user route. | `route-matrix.test.ts`; `worker-exposure.spec.ts` (e2e); `docs/security/m2-worker-exposure-review.md` |
| **Owner/accountant data** | GST, ageing, cash and every export are refused to managers and workers. The full company export also needs `employee.cost_rate.read`, which only the owner has. | `route-matrix.test.ts`; `reporting.test.ts` role tests; #196 |
| **Tenant isolation** | Every row lock is company-scoped, with no unscoped form of `lockRow` (#162/#183). Object reads use `requireSameCompany`. Report, export and label reads filter by `company_id`. | `receipts.test.ts` and `expenses.test.ts` cross-company lock regressions; `tenancy*.test.ts` |
| **Money endpoints** | Duplicate submissions are idempotent; negative amounts and overpayments are refused; voids correct records rather than edit them; recoverable GST is never counted as profit. | #59 acceptance spec (4 company variants, dashboard = reports = database); `docs/security/m3-financial-review.md` |
| **File uploads** | Uploads are private, size-limited and type-checked. Downloads use 5-minute signed links served as attachments. Unattached uploads are cleaned up by a least-privilege login, and failed deletions are retried. | `documents.test.ts`; `document-cleanup.test.ts` (#170); `expenses.spec` real upload |
| **PDF and CSV output** | PDF rendering has budgets (rows, characters, pages, bytes, time, concurrency); hostile content stays inert. CSV cells that could run as formulas are neutralised, and money is exported as plain signed numbers. | `invoice-pdf.test.ts` (#70); `csv-export.test.ts`; `docs/security/pdf-csv-review.md` |
| **Exports** | Exports are throttled to 5 a minute per user and per IP, audited, and sent `no-store`. Incomplete GST is refused. | `reporting.test.ts` (#56) |
| **Design samples** | The unauthenticated M0 design previews and design-system sample return 404 in production. Staging and development still serve them. | `tests/unit/design-gate.test.ts`. Checked against a production build: `APP_ENV=production` returned 404 on all four paths; `APP_ENV=staging` returned 200. |
| **Database privileges** | The web role can't change append-only financial history or GST postings (#166). It can't delete documents or read the cleanup outbox (#170). | `runtime-role.test.ts`; `document-cleanup.test.ts` |
| **Dependencies** | `pnpm audit --prod`: **no known vulnerabilities**. Full audit: 2 moderate advisories in development-only ESLint tooling (minimatch), plus the one approved high exception (see below). | Run on 2 November 2026 |
| **Supply chain** | External container images and GitHub Actions are pinned to digests or commits. | #198; `staging-config.test.ts` |

## Open before real data (owner and operations)

1. **Malware scanning of uploads (#136).** Deferred by the owner on 24 October. This is an open risk, not an accepted one: uploads are private and never executed, but files are not scanned.
2. **Staging host hardening (#168).** Still to do: a non-superuser migration owner, the SCRAM password-verifier handoff, a policy blocking access to the cloud metadata service, Postgres/nginx privilege limits, and IPv6 rollout checks. These need the real host.
3. **Maintenance credentials (#170).** Provision the separate maintenance database login, the delete-only S3 credential and the cleanup timer when staging is set up.
4. **Development audit exception.** `GHSA-vfj7-8cjw-p6xm` (braces, in ESLint tooling) **expires 21 November 2026**, and CI fails after that date. Either upgrade the tooling or get a fresh owner decision before then. The production audit has no exceptions.
5. **Accountant review (#67)** of the GST outputs before real use.
6. **Staging smoke test (#65)** with synthetic data, once staging exists.

## Known limits (accepted, documented)

- **PDF time limit:** it is checked cooperatively by the renderer, not enforced by the operating system (#70).
- **Company export size:** the export is built in memory as one JSON file. That's fine at pilot size (#62).
- **Late bill evidence (#197, if merged):** API only, and refused on bills that have supplier credits.
