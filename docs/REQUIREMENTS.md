# Requirements

## Roles
Owner: all operations. Manager: job allocation and cost approvals. Bookkeeper: invoices/payments/reports. Employee: assigned jobs, hours and receipts. External contractor: only their offers and jobs, never selling prices, other contractor rates or profit.

## Functional modules
1. Dashboard: revenue, invoiced, received, incurred cost, gross profit, margins, customer overdue, supplier due.
2. Customer directory: multiple contacts and service locations; search and history.
3. Quotes: scope, lines, prices, expiry, approvals, variations; convert to job.
4. Jobs: unique per-company number, SLA/dates, status timeline, multiple site visits, employee/subcontractor assignments, supporting documents.
5. Employees: assignments, timesheets, historical hourly cost snapshots. Not payroll processing.
6. Contractors: offers, accepted fixed/hourly rates, acceptance timestamps, approved bills, partial payments.
7. Expenses: employee labour, contractors, equipment/materials, travel, parking and misc. Attach receipts and require approval.
8. Invoices: unique number on issue, item lines, PDF, due date, multiple invoices per job, partial receipts, credit notes, void with audit.
9. Supplier bills: received/approved/paid states, partial payments, attachments and due dates.
10. Reports: profit per job/customer/month, receivable/payable ageing, cash received/paid, exports.
11. Documents: photos, site reports, signatures, receipt uploads, private tenant-scoped access.
12. Administration: roles, company profile, numbering, history and backups.

## Core workflow
Incoming request → Quote approved → Job created → Manager assigns employee or contractor offer → Work/time/expenses captured → Completion approved → Invoice issued → Payments allocated → Reports.

## Important business rules
Job profit derives from recognised revenue and incurred cost, not cash movement. Estimated vs actual, committed vs incurred and paid vs unpaid have distinct definitions. Price changes and approved rates snapshot at acceptance. Corrections traceable. Contractor access strictly restricted. Jobs can cancel while preserving real costs.

## MVP excluded
GST/BAS, superannuation, PAYG/STP, full payroll and automated bank payments. No tax compliance claim. Mobile offline use and accounting APIs are later releases.

## GST scope update (2026-10-22)
GST is now INCLUDED in v1; read [Australian GST requirements](GST.md). Any previous text excluding GST/BAS is superseded for GST computation and draft BAS support only. BAS lodgement, superannuation, PAYG/STP and payroll processing remain excluded. Implement effective-dated GST registration, taxable/GST-free/input-taxed/out-of-scope codes, GST-inclusive/exclusive pricing, supplier credit eligibility, mixed lines, payment-basis attribution, tax invoice validation, adjustments, period locking and accountant export. Complete the GST tests before production use.
