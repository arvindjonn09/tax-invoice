# Database and financial rules

## Tables
companies, users, memberships, customers, customer_contacts, locations, quotes, quote_items, jobs, job_visits, job_status_events, assignments, employees, employee_rate_history, timesheets, contractors, contractor_offers, contractor_acceptances, job_costs, supplier_bills, supplier_bill_items, supplier_payments, supplier_payment_allocations, invoices, invoice_items, invoice_credit_notes, customer_receipts, receipt_allocations, documents, audit_events, idempotency_keys.

Each company-owned entity has company_id and unique ID; human job/invoice numbers unique per company. All date-times UTC with Australia/Sydney display; AUD cents stored as integer/BigInt with bounds and explicit rounding rules.

## Financial definitions
- Quoted revenue: accepted quote and approved variations.
- Invoice revenue for MVP reporting: issued invoice amounts, net of credit notes; clearly label this as *invoiced* profit basis.
- Incurred costs: approved timesheets valued at snapshotted cost rate plus recognised/allocated subcontractor bills and approved expenses.
- Committed costs: signed but not yet incurred obligations; do not double count against later bills.
- Gross job profit = invoiced job revenue - incurred job costs.
- Margin = profit / invoiced job revenue; N/A for zero.
- Customer due = invoices - credits - allocated receipts.
- Supplier due = bills - credits - allocated supplier payments.
- Cash movement = receipts minus payments, **not** profit.
- Do not count both timesheet and derived cost; link underlying record to cost once.
- No issued financial record deletion; use auditable reversal/credit/void.

## Worked test
Invoice 250000 cents; contractor 90000; employee 30000; materials 15000; travel 10000. Costs 145000; profit 105000 (42%). Customer receipt 100000 leaves 150000 due. Contractor payment 40000 leaves 50000 due; neither modifies profit.

## Required tests
Partial/multiple payment allocations, retries and concurrency, zero/negative values and large numbers, void after receipt, refunds, credits, rate change historical preservation, incorrect tenant IDs, end-of-month reporting, filtering and sum reconciliation.