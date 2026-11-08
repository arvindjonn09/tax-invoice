# Changelog

All notable changes to JobFlow. Dates are Australia/Sydney. Each entry links the issue it closed.

## Unreleased

### Added

- A company's access mode and trial dates can now only be changed through the platform operator, enforced in the database, and a new company must choose its access mode. The data export's tables and columns are pinned by a test, and the Better Auth account endpoints are checked at runtime ([#260](https://github.com/arvindjonn09/tax-invoice/issues/260)).
- A daily backup check on the self-hosted site emails the operator when the nightly backup fails or the Windows file share falls more than 2 days behind ([#355](https://github.com/arvindjonn09/tax-invoice/issues/355)).
- Backups to the Windows share now notice when the share is offline, grant read access correctly on PostgreSQL 16, use the app database's own host and port, and keep database passwords off command lines ([#353](https://github.com/arvindjonn09/tax-invoice/issues/353)).
- Issued invoices and credit notes now freeze the organisation's phone, business email, website and logo, and their PDFs show them with the logo embedded from private storage. Sent quotes freeze the same details plus "about" ([#229](https://github.com/arvindjonn09/tax-invoice/issues/229)).
- Password reset emails are limited per IP and per account, so someone who knows an address can't use up its resets ([#318](https://github.com/arvindjonn09/tax-invoice/issues/318)).
- Uploaded files are scanned for malware with ClamAV before they're stored. Infected and password-protected files are refused, and in every production build uploads stop safely when the scanner is unavailable (#136).
- Signing up no longer takes a password: you set it from an emailed link, so nobody can choose a password for an address they don't control ([#327](https://github.com/arvindjonn09/tax-invoice/issues/327)).
- A timer runs the scheduled jobs every 5 minutes on the self-hosted site, so trial reminders go out, with one install script for it and the maintenance page ([#234](https://github.com/arvindjonn09/tax-invoice/issues/234)).
- A "We'll be back soon" page during deploys and whenever the app is down, with a deploy script for the self-hosted site that keeps it up until the new build is ready ([#326](https://github.com/arvindjonn09/tax-invoice/issues/326)).
- Nightly encrypted backups of the database and documents on the self-hosted site, copied to a Windows file share and verified there; backups missed while the Windows computer is off are copied within an hour of it coming back ([#351](https://github.com/arvindjonn09/tax-invoice/issues/351)).
- Mistyping the password during operator two-factor enrolment no longer uses up the one-time code.
- In production, a platform operator has to pass TOTP again after 12 hours ([#323](https://github.com/arvindjonn09/tax-invoice/issues/323)).
- Hardening: exports audit only validated values, someone demoted can no longer reach an invoice PDF they once generated, and the route policy tests close three gaps (part of [#260](https://github.com/arvindjonn09/tax-invoice/issues/260)).
- Each organisation can set its own logo, phone, business email, website and description in Settings and during onboarding ([#228](https://github.com/arvindjonn09/tax-invoice/issues/228)).
- Trial reminder emails at 7, 3 and 1 days left and when the trial ends, sent by `pnpm jobs:run`, plus one-time notices for owners ([#233](https://github.com/arvindjonn09/tax-invoice/issues/233)).
- A "We'll be back soon" page during deploys and whenever the app is down, with a deploy script for the self-hosted site that keeps it up until the new build is ready ([#326](https://github.com/arvindjonn09/tax-invoice/issues/326)).
- Issuing an invoice now needs the company's legal name, ABN and full address, whether or not it's registered for GST, and a due date on or after the issue date ([#348](https://github.com/arvindjonn09/tax-invoice/issues/348)).
- Operator area screens: extension requests (pending and decided), request review with approve or decline, company search with direct extensions and access changes, TOTP enrolment at `/operator/mfa`, and the authentication-code step on `/login`, with an operator runbook ([#232](https://github.com/arvindjonn09/tax-invoice/issues/232)).
- Settings → Trial: owners, managers and accountants see the trial status; owners can request more time, see whether a request is pending, and see past outcomes. The trial banner's "Request extension" now opens it ([#232](https://github.com/arvindjonn09/tax-invoice/issues/232), part 1).
- The Terms of Service and Privacy Policy are published, in effect from 7 November 2026, after the owner's approval ([#212](https://github.com/arvindjonn09/tax-invoice/issues/212)).
- Onboarding shows "Step 1 of 2", explains the one-company limit with the support address, then offers the optional details or "Skip for now"; owners see "Finish setting up your company" on their dashboard until it's done or dismissed ([#225](https://github.com/arvindjonn09/tax-invoice/issues/225)).
- Company phone, business email, website, about text and logo API. Logos must be real PNG or JPEG files, have their metadata removed, and old ones are kept for documents already sent; the screens follow in #229 ([#227](https://github.com/arvindjonn09/tax-invoice/issues/227)).
- Onboarding shows "Step 1 of 2", explains the one-company limit with the support address, then offers the optional details or "Skip for now"; owners see "Finish setting up your company" on their dashboard until it's done or dismissed ([#225](https://github.com/arvindjonn09/tax-invoice/issues/225)).
- Trial extension requests: owners can ask for more time, including while read-only, and the operator API approves or declines them; the screens follow in #232 ([#231](https://github.com/arvindjonn09/tax-invoice/issues/231)).
- Accepting an invitation no longer reveals whether an email address has an account. People now set their password from an emailed link and sign in before they join a company ([#263](https://github.com/arvindjonn09/tax-invoice/issues/263)).
- Platform operator role with a two-key check, TOTP enrolment by host-issued code, and `pnpm operator` to grant access and extend trials; the screens follow in #232 ([#230](https://github.com/arvindjonn09/tax-invoice/issues/230)).
- Password reset API: request a link by email and set a new password, which signs out every device; the pages follow in #224 ([#219](https://github.com/arvindjonn09/tax-invoice/issues/219)).
- A bill's tax invoice that arrives later moves its claimable GST from job cost to GST credits on the day it's held, without editing the bill (#142).
- Accessibility sweep: every screen for every role passes axe (WCAG 2.2 AA) and reflows at 360, 768 and 1440 px in both themes, with a keyboard skip-link check (#60).
- Pre-production security audit with a generated route permission matrix kept in step with the code by CI; the static design samples are not served in production (#61).
- Subcontractors send their own tax invoices for accepted work; the office verifies them and approves them into supplier bills (#139).
- Deployment and rollback runbook, and user guides for invoices, payments and GST (#66).
- Debtor and creditor ageing as at any day, cash movement (not profit), and accountant CSV exports for GST, profit, ageing and cash, for owners and accountants only (#56).
- Report reads load only the documents active in the range, and drill-down events are paged (#157).
- Reports screens: job profit, draft GST with its composition, who owes what and cash movement, with date filters, drill-down to the source records and CSV export (#58).
- The real financial dashboard: filtered profit and cash, outstanding balances, draft GST and direct links to overdue invoices (#57).
- The critical acceptance test runs end to end for a not-registered company and three GST-registered variants, reconciling the dashboard, reports and database (#59).

### Security

- The development-tooling audit exception for braces (GHSA-vfj7-8cjw-p6xm) is gone: braces is no longer installed, and the full and production audits both run with no exceptions (#202).

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

- Security (#166): reserve GST posting writes to hardened source triggers and remove mutation grants from append-only financial records; period-lock and runtime-role regressions added.
- Bound PDF rendering input, pages, output, concurrency and cooperative layout time; preserve text-only rendering and typed CSV protections (#70).
- Production hardening (#168, in progress): pin external container images to verified digests and share readiness results for two seconds across concurrent probes.
