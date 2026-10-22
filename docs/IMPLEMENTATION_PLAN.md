# Development milestones

Milestones M0–M5 are tracked as GitHub milestones with one issue per task:
https://github.com/arvindjonn09/tax-invoice/milestones. Backend milestones are built in this order. Each task is one
reviewed PR with passing CI (type-check, lint, tests, security checks).

## M0 Foundation
- [ ] Tech-stack ADR and monorepo scaffold (Next.js strict TypeScript)
- [ ] PostgreSQL Docker Compose + Prisma + test database
- [ ] CI: type-check, lint, unit/integration tests, build, dependency audit, secret scan, static analysis; protected `main`
- [ ] Core tenancy schema: companies, users, memberships, roles, audit events, idempotency keys
- [ ] Authentication, sessions, login throttling
- [ ] Authorisation framework (deny by default, company + object scope) with access-denied tests
- [ ] Money, GST and job-profit calculation core (pure domain package) with the combined fixtures
- [ ] Design tokens, themes, typography, shadcn/ui setup — #18 specification in [design system](design/design-system.md); implementation and rendered tests pending #19
- [ ] Application shell and role-aware navigation
- [ ] Database-backed synthetic demo data with a persistent "Demo Data" indicator
- [ ] Dashboard and invoice-builder **design previews** (non-functional, clearly labelled, no financial logic) — #22 [screen specifications and owner review sheet](design/review-22.md) drafted; owner review and #23 implementation pending
- [ ] Threat model; GST + profit rules verified against ATO sources — threat model drafted in
  [security/threat-model.md](security/threat-model.md) for #24; architect/QA design review completed; controls unverified, mitigation follow-ups #70/#71

## M1 Customers, company settings and jobs
- [ ] Company profile and effective-dated GST registration settings (ABN, basis, BAS period)
- [ ] User and role management
- [ ] Customers, locations and contacts
- [ ] Employee records
- [ ] Per-company job numbers, detail, status timeline, visits
- [ ] Assignment to employee and authorisation tests

## M2 Contractors, timesheets and job expenses
- [ ] Private document storage with signed URLs
- [ ] Contractors, offers, approvals and acceptance history; restricted contractor portal
- [ ] Employee timesheets with cost-rate snapshots
- [ ] Expenses with GST code, creditable portion, receipts and approvals
- [ ] Work evidence and completion approval

## M3 Quotes, bills, invoices and payments
- [ ] Quotes with tax-coded lines and accepted variations
- [ ] Supplier bills with creditable GST and payment allocations
- [ ] Tax invoices: mixed tax lines, ex/incl entry, validation before issue, numbering, credits, voids
- [ ] Invoice builder UI and PDF ("Tax Invoice" vs "Invoice")
- [ ] Customer receipts and allocations
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
