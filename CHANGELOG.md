# Changelog

All notable changes to JobFlow. Dates are Australia/Sydney. Each entry links the issue it closed.

## Unreleased

### Added

- Subcontractors send their own tax invoices for accepted work; the office verifies them and approves them into supplier bills (#139).
- Deployment and rollback runbook, and user guides for invoices, payments and GST (#66).
- Debtor and creditor ageing as at any day, cash movement (not profit), and accountant CSV exports for GST, profit, ageing and cash, for owners and accountants only (#56).
- Report reads load only the documents active in the range, and drill-down events are paged (#157).
- Reports screens: job profit, draft GST with its composition, who owes what and cash movement, with date filters, drill-down to the source records and CSV export (#58).

## M5 Production pilot (in progress)

### Added (2026-10-25)

- Encrypted backups of the database and every document, with a verified restore, a restore drill, retention, and a nightly timer with an off-site copy (#63). See `docs/ops/backups.md`.
- Staging configuration: Docker images, Compose, nginx with TLS, a least-privilege database role, health and readiness checks, and CI image and config checks. The deploy job stays off until the owner turns it on (#64). See `docs/ops/staging.md`.
- Uploads never attached to a record are deleted after 7 days, with an audit event (#137).
- Supplier credit notes against bills (#140), and paying on-account expenses through supplier payments (#141).

## M4 Profit and GST reporting

### Added (2026-10-25)

- A shared backend for job profitability and the draft GST/BAS summary (G1, 1A, 1B). It covers the cash and non-cash bases, closed periods and explicit adjustments (#54, #55).
- Cash-basis receipts can't be dated before an invoice's latest credit (#54).

## M3 Invoicing and payments

### Added (2026-10-24)

- Customer tax invoices, credit notes and voids (#47).
- Stored PDFs for issued invoices and credit notes (#48).
- The invoice list, GST-aware builder and issued view (#49).
- Idempotent customer receipts, refunds and allocations (#50).
- Supplier bills with creditable GST, and idempotent supplier payments (#46).
- Payment screens for bills, supplier payments and receipts (#51).
- Quotes and variations with conversion to jobs, plus their screens (#44, #45).
- A money-safety suite for concurrency, idempotency and corrections (#52).

## M2 Jobs and work

### Added (2026-10-23 to 2026-10-24)

- Jobs with numbering, a status machine, immutable history and visits, plus their screens (#31, #33).
- Employee assignments and scoped job access (#32).
- Contractors, offers and acceptance snapshots, the subcontractor portal, and their screens (#35, #36, #37).
- Job expenses with GST codes, creditable GST and approvals, plus their screens (#40, #41).
- Employee cost-rate history and timesheets, plus their screens (#38, #39, #131).
- Work evidence and completion review (#42, #129, #147).
- A review of what workers can see, with a leak sweep (#43).

## M1 Company, people and customers

### Added (2026-10-23)

- The company profile, ABN checksum and effective-dated GST registration, plus their settings screens (#25, #26).
- Owner invitations and audited role management (#27).
- Customers, contacts and service locations, plus their directory (#28, #29, #113).
- Employee records (#30).
- Private document storage with content-sniffed uploads and signed links (#34).

## M0 Foundation

### Added (2026-10-22 to 2026-10-23)

- A strict Next.js workspace, PostgreSQL with Prisma, and isolated integration tests (#8, #9, #11).
- The core tenancy schema and integrity constraints (#12).
- Money, GST and job-profit calculation core (#17).
- A transactional audit log (#15).
- Email and password sign-in with database sessions (#13).
- Deny-by-default authorisation (#14).
- Design tokens, themes, the application shell, and a Demo Data banner backed by synthetic database data (#18, #19, #20, #21).
- Design previews of the dashboard and invoice builder (#22, #23).
- A web security baseline, CSRF origin checks and safe logging (#71).
- CI quality gates (#10).

### Security

- Updated Zod for a resource-exhaustion advisory (#121).

## Release log

| Date | Environment | Commit | Backup before | Checks                                                       |
| ---- | ----------- | ------ | ------------- | ------------------------------------------------------------ |
| —    | staging     | —      | —             | First deploy waits for the owner to provision staging (#64). |
