# Development milestones

Milestones M0–M5 are tracked as GitHub milestones with one issue per task:
https://github.com/arvindjonn09/tax-invoice/milestones. Backend milestones are built in this order. Each task is one
reviewed PR with passing CI (type-check, lint, tests, security checks).

## M0 Foundation
- [x] Tech-stack ADR and monorepo scaffold (Next.js strict TypeScript) — #8 merged after passing CI and exact-head Claude supervisor review
- [x] PostgreSQL Docker Compose + Prisma + test database — #9 merged via #82 after real Compose CI and exact-head supervisor approval
- [ ] CI: type-check, lint, unit/integration tests, build, dependency audit, secret scan, static analysis; protected `main`
- [ ] Test infrastructure — #11 named projects, per-test rollback, synthetic factories, browser checks and [domain coverage strategy](testing/strategy.md); pending CI and exact-head supervisor merge gate
- [ ] Core tenancy schema: companies, users, memberships, roles, audit events, idempotency keys — #12 implementation and integration evidence: [core tenancy](testing/core-tenancy.md); pending CI/supervisor merge gate
- [ ] Authentication, sessions, login throttling
- [ ] Authorisation framework (deny by default, company + object scope) with access-denied tests
- [ ] Money, GST and job-profit calculation core (pure domain package) with the combined fixtures
- [ ] Design tokens, themes, typography, shadcn/ui setup — #18 specification in [design system](design/design-system.md); tokens, themes, self-hosted Geist, shadcn base and component/browser tests implemented in #19; CI and exact-head review pending
- [ ] Application shell and role-aware navigation
- [ ] Database-backed synthetic demo data with a persistent "Demo Data" indicator
- [ ] Dashboard and invoice-builder **design previews** (non-functional, clearly labelled, no financial logic) — #22 [screen specifications and owner review sheet](design/review-22.md) owner layouts approved with changes on #22; requested specification updates in #76, rendered previews merged via #102 and owner approval recorded on #23 (2026-10-23)
- [ ] Threat model — drafted in [security/threat-model.md](security/threat-model.md) for #24; architect/QA design review completed; controls unverified, mitigation follow-ups #70/#71
- [ ] GST + profit rules verified against ATO sources — research and exact-cent contract prepared in #16; QA/code review completed, accountant review before production remains required


## M1 Customers, company settings and jobs
- [ ] Company profile and effective-dated GST registration settings (ABN, basis, BAS period)
- [x] User and role management — #27 merged via PR #108 after passing CI and Claude review; owner access screens, expiring invitations, audited access changes and concurrent last-owner protection
- [x] Customers, locations and contacts — #28 merged via PR #107; concurrency regression tests cover primary contacts and atomic audit history
- [x] Customer directory screens — #29 implemented with search/sort/pagination, billing forms, contacts and sites; [verification](testing/customer-screens.md); merged via PR #112 after passing CI and Claude review
- [x] Primary-contact audit and uniqueness follow-up — #113 merged via PR #114; transactional demotion events and a partial unique index
- [x] Employee records — #30: optional same-company user link, active/inactive, audited; no payroll
- [x] Per-company job numbers, detail, status timeline, visits — #31: atomic per-company numbering, status machine with immutable history, visits; GST-exclusive cents price
- [x] Assignment to employee and authorisation tests — #32 merged via PR #115; visit scoping and locked employee eligibility; [API contract](architecture/assignments.md)
- [x] Job screens — #33 directory, role-scoped detail tabs, visits, assignments and status timeline; [verification](testing/job-screens.md); merged via PR #118

## M2 Contractors, timesheets and job expenses
- [ ] Contractor directory and offer screens — #36; [verification](testing/contractor-screens.md); pending CI/cross-review
- [ ] Subcontractor portal — #37 own offers/accepted work, redacted direct reads and evidence UI; [contract](architecture/subcontractor-portal.md); pending #42 integration, CI and cross-review
- [x] Private document storage with signed URLs — #34: app-mediated upload with content sniffing, random keys, 5-minute HMAC download links after authz
- [ ] Contractors, offers, approvals and acceptance history; restricted contractor portal
  - #35 schema + API: contractors (ABN, GST flag, optional subcontractor login), fixed/hourly offers in GST-exclusive cents with a tax code, accept/decline with immutable acceptance snapshots and committed cost recorded once; portal screens remain #37
- [ ] Employee timesheets with cost-rate snapshots
  - #38 schema + API: append-only effective-dated employee cost rates; timesheets per job/visit by live-assigned employees (re-checked under job→employee locks); approval snapshots the rate on the work date and the cost once; decided timesheets frozen, reversal corrections; rates/costs only with employee.cost_rate.read; screens remain #39
  - #131 screens: `/employees` directory and detail (create/edit, link a login via employee-role-only `GET /api/employees/linkable-users`, deactivate/reactivate) and the append-only cost-rate history (add with employee.write, read with employee.cost_rate.read; accountant read-only without rates)
- [ ] Expenses with GST code, creditable portion, receipts and approvals
  - #40 schema + API: job/general expenses, ex/incl entry, tax code, creditable share, receipt, settlement (paid at purchase / on account, company default), approval snapshots the cost once, decided expenses frozen, reversal corrections; screens remain #41
- [x] Work evidence and completion approval — #42: append-only photos/notes/signatures from workers on the job; submit → review (approve or rework) via the status machine; completion and rework only through the review, workers locked and rechecked before every write, visit-only workers kept to their visits

## M3 Quotes, bills, invoices and payments
- [ ] Quotes with tax-coded lines and accepted variations
- [ ] Supplier bills with creditable GST and payment allocations
  - #46 schema + API: bills from suppliers or contractors, keeping the supplier's line GST as issued (R3), linked to an accepted offer (releases the commitment once) and job; creditable GST only with verified evidence on a registered date, limited to a recorded business share; job cost (ex GST + non-creditable GST) snapshotted once; idempotent supplier payments (key + fingerprint, one transaction, locked bills, no overpayment, cash-basis 1B attribution); immutable except one-way voids. Follow-ups: #139 portal bills, #140 supplier credits, #141 on-account expenses, #142 evidence reclassification
  - #51 screens: Payments keeps obligations (supplier bills, with paid and owing) separate from settlements (supplier payments and customer receipts/refunds); bill entry with creditable-GST evidence and business-use share; payment and receipt entry allocate across owing bills or invoices (amount = sum of allocations, one idempotency key per attempt); detail pages with void-with-reason; the invoice list now returns received and outstanding balances for issued invoices
- [x] Tax invoices: mixed tax lines, ex/incl entry, validation before issue, numbering, credits, voids — #47
- [ ] Invoice builder UI and PDF ("Tax Invoice" vs "Invoice")
- [x] Customer receipts and allocations — #50: idempotent, transactional, no overpayment, refunds, cash-basis GST attribution per allocation
- [ ] Financial concurrency/idempotency tests

## M4 Profit, GST reporting and dashboard
- [ ] Job profitability: estimated, committed, incurred and paid costs — GST-exclusive, tested with GST fixtures
- [ ] Draft GST/BAS summary (G1, 1A, 1B), cash/non-cash attribution, period lock and adjustments
- [ ] AR/AP ageing, cash tracking, CSV and accountant exports
- [ ] Real dashboard and reports UI
- [ ] End-to-end critical acceptance test (registered and not-registered variants) and reconciliation tests

## M5 Production pilot
- [ ] Mobile-responsive UX and accessibility audit
- [ ] Threat-model/permission audit
- [ ] Record retention and data export
- [ ] Database and storage backup/restore test
- [ ] Staging deployment (Docker, HTTPS) and smoke test with synthetic data
- [ ] Deployment, rollback and user documentation
- [ ] Accountant review of GST outputs before real use

## Acceptance
Invoice $2,500 ex GST; costs $1,450; profit $1,050; margin 42%; customer receipt $1,000 leaves $1,500 outstanding
(not registered) or $1,750 (registered, $2,750 incl GST); contractor bill $900 ex GST paid $400 leaves $500 (not registered)
or $590 (registered) outstanding. Payments and recoverable GST do not change profit. See [GST.md](GST.md#combined-gst-and-profit-acceptance-fixture).

At every milestone: implement schema, routes, UI, tests and documentation; do not mark done without passing tests. Avoid bulk unreviewed implementation.
