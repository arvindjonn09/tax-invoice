# AI coding-agent instructions (Codex, Claude Code and others)

You are implementing **JobFlow**, a small-business job management, tax-invoice and job-profitability platform for an
Australian contracting company. Read all docs before coding. Inspect the repository before editing and preserve prior work.

This file and [`CLAUDE.md`](CLAUDE.md) must stay consistent: `AGENTS.md` holds the **product and engineering rules**;
`CLAUDE.md` holds the **team workflow** (agent roles, GitHub issues, branches, PRs). If you change a rule here, check
`CLAUDE.md` still agrees, and vice versa.

## Required reading
- [plan.md](plan.md) — project overview, end goals, milestones and owner checkpoints
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — roles, modules, business rules, scope
- [docs/GST.md](docs/GST.md) — Australian GST rules and the combined GST + profit acceptance fixture
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — tables and financial definitions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md)
- [docs/UI_DESIGN.md](docs/UI_DESIGN.md) — design system, screens, accessibility
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — milestones M0–M5 (tracked as GitHub milestones/issues)

## Scope
- **Included in v1:** effective-dated GST registration; TAXABLE_10 / GST_FREE / INPUT_TAXED / OUT_OF_SCOPE line codes;
  GST-inclusive and GST-exclusive entry; mixed-tax lines; tax-invoice validation; supplier creditable-GST eligibility;
  cash/non-cash attribution; adjustments; period locking; **draft** GST/BAS summaries (G1, 1A, 1B) and accountant export.
- **Excluded:** BAS/tax lodgement, superannuation, PAYG withholding, STP, payroll processing, bank-payment initiation,
  MYOB/Xero integration and AI features in v1. Exclusions do not change the business's legal obligations.

## Mandatory technical requirements
- Modular monolith: Next.js App Router, strict TypeScript, PostgreSQL + Prisma, Tailwind/shadcn/ui, established auth library.
- Roles: `owner`, `manager`, `accountant` (bookkeeper), `employee`, `subcontractor`. Deny by default; server-side role,
  company and object-level checks on every operation, report, export and file download.
- Separate quoted, committed, incurred and paid costs; separately track invoiced, received and unpaid customer balances.
- Store AUD as integer cents (or safe BigInt); **never use floating point for money**. Snapshots preserve accepted rates,
  prices and tax-code percentages.
- Transactional and idempotent allocations for customer receipts and supplier payments; block duplicates and overpayments.
- No silent changes to issued invoices or approved financial records: credit note / void / reversal plus immutable audit events.
- Private uploads, signed expiring file access, rate limits, validated inputs, CSRF protection, no secrets or customer files in Git.
- Reuse third-party components only after auditing their licence; never copy MYOB branding or proprietary screens.

## GST and profit — built and tested together
GST calculation and job profitability are one piece of domain logic and must be implemented and tested together
(the same domain package, the same fixtures, the same PR when either changes):
- Job profit and margin use **GST-exclusive** amounts.
- **Recoverable GST is never revenue, profit or expense.** GST on sales is a liability to the ATO; creditable GST on
  purchases is an asset (input tax credit).
- Only **non-creditable** GST (e.g. no valid tax invoice, input-taxed activity, partial eligibility) is part of job cost.
- Every change to GST or profit code must keep the fixtures in [docs/GST.md](docs/GST.md#combined-gst-and-profit-acceptance-fixture)
  passing in both the GST-registered and not-registered variants.

## Demo data
Demonstration data is synthetic, stored in the database and flagged as demo. Whenever demo records exist the UI shows a
persistent, unmissable **"Demo Data"** indicator. Demo seeding must refuse to run against production. Never use real
customer, employee or tax-identifier data in seeds, tests or screenshots.

## Implementation order (backend milestones keep this order)
1. **M0 Foundation** — scaffolding, Postgres/Docker, CI, auth and roles, audit log, money/GST/profit calculation core,
   design tokens, navigation and app shell, demo-data indicator, and **design previews** (non-functional, clearly
   labelled) of the dashboard and invoice builder.
2. **M1** Customers, company GST settings, employees, jobs and statuses
3. **M2** Contractors, offers, timesheets, expenses (with GST treatment), documents
4. **M3** Quotes, supplier bills, tax invoices, receipts and payment allocations
5. **M4** Job profitability, draft GST/BAS, reports and the real dashboard
6. **M5** Security review, accessibility, backup/restore, staging pilot

Do not implement dashboard or invoice financial functionality ahead of the modules that supply its data.

## Quality gates (every application PR)
TypeScript strict type-check, lint, unit + integration tests (incl. authorisation), and security checks (dependency
audit, secret scan, static analysis) pass in CI before merge. Write tests and migrations alongside each change. Do not
claim a feature complete until tests run. Report known limitations. Keep docs and the milestone checklist updated.

## Financial fixture (GST-exclusive / not registered)
250000 invoice cents; costs 90000+30000+15000+10000 = 145000 cents; 105000 profit, 42% margin. Receipt 100000 → 150000
owing. Contractor payment 40000 against 90000 bill → 50000 owing. Payments must not change gross profit.
The GST-registered variant is in [docs/GST.md](docs/GST.md#combined-gst-and-profit-acceptance-fixture).

## UI
Read [docs/UI_DESIGN.md](docs/UI_DESIGN.md) before implementing screens. Original professional shadcn/ui-based design
system; consistent responsive shell; verify accessibility, mobile layouts, explicit ex/incl GST labelling and
server-side permissions.
