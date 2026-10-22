# Database and financial rules

## Tables
companies, company_gst_registrations, gst_periods, users, memberships, customers, customer_contacts, locations, quotes, quote_items, jobs, job_visits, job_status_events, assignments, employees, employee_rate_history, timesheets, contractors, contractor_offers, contractor_acceptances, job_costs, supplier_bills, supplier_bill_items, supplier_payments, supplier_payment_allocations, invoices, invoice_items, invoice_credit_notes, customer_receipts, receipt_allocations, gst_adjustments, documents, audit_events, idempotency_keys.

Each company-owned entity has company_id and unique ID; human job/invoice numbers unique per company. All date-times UTC with Australia/Sydney display; AUD cents stored as integer/BigInt with bounds and explicit rounding rules.

Every invoice, quote, bill and expense line stores: tax code, GST rate snapshot, GST-exclusive amount, GST amount, GST-inclusive amount, and (for purchases) creditable fraction and creditable GST. Demo records carry an `is_demo` flag (or belong to a demo company) so the UI can show the "Demo Data" indicator.

## Financial definitions
- Quoted revenue: accepted quote and approved variations.
- Invoice revenue for MVP reporting: issued invoice amounts, net of credit notes; clearly label this as *invoiced* profit basis.
- All revenue and cost figures used for profit are **GST-exclusive**. Recoverable GST (GST on sales; creditable GST on purchases) is never revenue, profit or expense.
- Incurred costs: approved timesheets valued at snapshotted cost rate plus recognised/allocated subcontractor bills and approved expenses, each at GST-exclusive amount **plus any non-creditable GST**.
- Committed costs: signed but not yet incurred obligations; do not double count against later bills.
- Gross job profit = invoiced job revenue - incurred job costs.
- Margin = profit / invoiced job revenue; N/A for zero.
- Customer due = invoices (GST-inclusive) - credits - allocated receipts.
- Supplier due = bills (GST-inclusive) - credits - allocated supplier payments.
- Draft net GST = GST on sales (1A) - creditable GST on purchases (1B) ± adjustments, attributed per the company's accounting basis. This is a liability/asset, not profit.
- Cash movement = receipts minus payments, **not** profit.
- Do not count both timesheet and derived cost; link underlying record to cost once.
- No issued financial record deletion; use auditable reversal/credit/void.

## Worked test (GST-exclusive / not registered)
Invoice 250000 cents; contractor 90000; employee 30000; materials 15000; travel 10000. Costs 145000; profit 105000 (42%). Customer receipt 100000 leaves 150000 due. Contractor payment 40000 leaves 50000 due; neither modifies profit.

The GST-registered variant of this test is in [GST.md](GST.md#combined-gst-and-profit-acceptance-fixture); both variants must pass.

## Required tests
Partial/multiple payment allocations, retries and concurrency, zero/negative values and large numbers, void after receipt, refunds, credits, rate change historical preservation, incorrect tenant IDs, end-of-month reporting, filtering and sum reconciliation. GST: mixed codes, ex/incl entry, rounding boundaries, non-creditable GST in cost, registration-date boundaries, cash vs non-cash attribution, locked periods — always asserted together with the job-profit result.
