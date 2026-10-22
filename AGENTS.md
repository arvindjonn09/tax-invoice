# Codex / AI coding-agent instructions

You are implementing a small-business job management and invoice tracking platform. Read all docs before coding. Inspect repository before editing and preserve prior work.

## Mandatory technical requirements
- Modular monolith: Next.js strict TypeScript, PostgreSQL + Prisma, Tailwind/shadcn, established authentication.
- Secure server-side permission checks for owner, admin, bookkeeper, employee and subcontractor; company and object scope on every operation.
- Separate quoted, committed, incurred and paid costs; separately track invoiced, received and unpaid customer balances.
- Store AUD in integer cents or safe BigInt; **never use floating point for money**. Snapshots preserve accepted rates and prices.
- Transactional and idempotent allocations for customer receipts and supplier payments; block duplicates and overpayments.
- No silent changes to issued invoices or approved financial records. Credit/void/reversal and immutable audit events instead.
- No GST, BAS, super, PAYG, STP, payroll engine, tax lodgement or bank-payment initiation. This exclusion does not change external legal obligations.
- Reuse documented components only after auditing them; no copying MYOB branding or proprietary screens.
- Private uploads, signed file access, rate limits, validated inputs, CSRF protections, no secrets or customer files in Git.
- Synthetic demo data; test tenant isolation, RBAC, concurrency, corrections, rounding and report reconciliations.

## Implementation order
1. Docs + scaffolding + Postgres/Docker + CI + auth
2. Customers + jobs + statuses
3. Employees + contractors + offers + labour/expense tracking
4. Quotes + supplier bills + invoices + partial payments
5. Profit and outstanding reports + CSV/PDF
6. Security review, backup/restore, staging pilot

Write tests and migrations alongside each change. Do not claim feature complete until tests run. Report known limitations. Keep docs and checklist updated.

## Financial fixture
250000 invoice cents; costs 90000+30000+15000+10000 = 145000 cents; 105000 profit, 42% margin. Receipt 100000 → 150000 owing. Contractor payment 40000 against 90000 bill → 50000 owing. Payments must not change gross profit.