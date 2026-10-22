# Requirements

## Roles
- **Owner:** all operations.
- **Manager:** jobs, allocation of work, cost approvals, job profitability.
- **Accountant** (bookkeeper): invoices, bills, payments, reports, GST settings review and draft GST/BAS exports.
- **Employee:** assigned jobs, hours, receipts and completion evidence only.
- **Subcontractor:** only their own offers, jobs, bills and evidence — never selling prices, other contractors' rates or profit.

## Functional modules
1. Dashboard: revenue (explicitly ex/incl GST), invoiced, received, incurred cost, gross profit, margins, customer overdue, supplier due, draft GST position.
2. Customer directory: multiple contacts and service locations; ABN; search and history.
3. Quotes: scope, lines with tax codes, prices, expiry, approvals, variations; convert to job.
4. Jobs: unique per-company number, SLA/dates, status timeline, multiple site visits, employee/subcontractor assignments, supporting documents.
5. Employees: assignments, timesheets, historical hourly cost snapshots. Not payroll processing.
6. Contractors: offers, accepted fixed/hourly rates, acceptance timestamps, approved bills, partial payments.
7. Expenses: employee labour, contractors, equipment/materials, travel, parking and misc. GST code and creditable portion. Attach receipts and require approval.
8. Invoices: tax invoice (or plain invoice when not GST-registered), unique number on issue, mixed tax-code lines, ex/incl GST entry, PDF, due date, multiple invoices per job, partial receipts, credit notes, void with audit.
9. Supplier bills: received/approved/paid states, supplier ABN, tax-invoice attachment, creditable GST, partial payments, due dates.
10. GST: company registration and accounting basis (effective-dated), period close/lock, draft GST/BAS summary (G1, 1A, 1B) with drill-down and accountant export. See [GST.md](GST.md).
11. Reports: profit per job/customer/month, receivable/payable ageing, cash received/paid, CSV exports.
12. Documents: photos, site reports, signatures, receipt uploads, private tenant-scoped access.
13. Administration: users and roles, company profile, numbering, audit history and backups.

## Core workflow
Incoming request → Quote approved → Job created → Manager assigns employee or contractor offer → Work/time/expenses captured → Completion approved → (Tax) invoice issued → Payments allocated → Profit and draft GST reports.

## Important business rules
- Job profit derives from recognised (invoiced) revenue and incurred cost, not cash movement.
- Profit uses GST-exclusive amounts. Recoverable GST is never revenue, profit or expense; only non-creditable GST is a cost. GST and profit logic are built and tested together.
- Estimated vs actual, committed vs incurred and paid vs unpaid have distinct definitions.
- Price changes, approved rates and tax-code percentages snapshot at acceptance/issue.
- Corrections are traceable (credit, void, reversal) — never silent edits.
- Contractor access strictly restricted. Jobs can be cancelled while preserving real costs.

## Demo data
Synthetic demonstration data is stored in the database, flagged as demo, and the UI shows a persistent **"Demo Data"** indicator while it exists. Demo seeding is refused in production.

## Out of scope (v1)
BAS/tax lodgement, superannuation, PAYG withholding, STP, payroll processing and automated bank payments. GST/BAS output is a draft for an accountant or registered tax agent to review; the app makes no tax-compliance claim. Mobile offline use and accounting-software APIs are later releases.
