# Development milestones

## M0 Foundation
- [ ] Scaffold Next.js TypeScript project + design system
- [ ] PostgreSQL Docker Compose + Prisma + seed synthetic data
- [ ] Authentication, sessions, company and roles
- [ ] CI lint/typecheck/unit test scripts
- [ ] Access denied tests

## M1 Customers and jobs
- [ ] Customers, locations and contacts
- [ ] Per-company job numbers, detail, status timeline
- [ ] Assignment to employee and authorisation tests

## M2 Contractors and job expenses
- [ ] Contractors, offers, approvals and acceptance history
- [ ] Employee timesheets with cost-rate snapshots
- [ ] Expense categories, receipts, approvals and private storage
- [ ] Work evidence and completion approval

## M3 Invoices and payments
- [ ] Quotes and accepted variations
- [ ] Supplier bills and their payment allocations
- [ ] Customer invoice lines/PDF, partial receipts, credits, voids
- [ ] Financial transaction concurrency/idempotency tests

## M4 Profit and reporting
- [ ] Separate estimated, committed, incurred and paid costs
- [ ] Invoiced profit and margin by job/customer/date
- [ ] AR/AP ageing, cash tracking, CSV exports
- [ ] Dashboard reconciliation tests

## M5 Production pilot
- [ ] Mobile-responsive UX and accessibility
- [ ] Threat-model/permission audit
- [ ] Database and storage restore test
- [ ] Staging smoke test with synthetic data
- [ ] Deployment and rollback documentation

## Acceptance
Invoice $2500; costs $1450; profit $1050; margin 42%; customer receipt $1000 leaves $1500 outstanding; contractor bill $900 paid $400 leaves $500 outstanding. Payment changes do not change profit.

At every milestone: implement schema, routes, UI, tests and documentation; do not mark done without passing tests. Avoid bulk unreviewed implementation.