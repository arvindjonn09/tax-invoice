# Database and financial rules

## Tables
companies, company_gst_registrations, gst_periods, users, memberships, user_invitations, customers, customer_contacts, locations, quotes, quote_items, jobs, job_visits, job_status_events, assignments, employees, employee_rate_history, timesheets, contractors, contractor_offers, contractor_acceptances, job_costs, supplier_bills, supplier_bill_items, supplier_payments, supplier_payment_allocations, supplier_payment_gst_adjustments, supplier_credits, supplier_credit_items, supplier_credit_gst_adjustments, supplier_payment_expense_allocations, supplier_payment_expense_gst_adjustments, invoices, invoice_items, invoice_credit_notes, customer_receipts, receipt_allocations, receipt_gst_adjustments, gst_adjustments, documents, audit_events, idempotency_keys.

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
- On-account expenses (#141): an approved original expense settled "on account" owes its supplier its GST-inclusive total, less live supplier payments allocated to it.
  - A supplier payment settles either bills or on-account expenses, never both in one payment, and pays one supplier: the same contractor, or the same supplier name.
  - The rules match bills: an idempotency key, no overpayment, cash-basis input tax credit attributed per allocation, and append-only corrections (`supplier_payment_expense_gst_adjustments`) when a payment is voided.
  - **GST snapshot used for payments:** a payment attributes against the expense's live tax snapshot. After a cost-only reversal, that's the approved correction's creditable GST, or none if there isn't one.
  - **Changes while payments exist:** a reversal of an on-account expense, and a correction of one (on submission and on approval), are refused while live payments are allocated. Void the payments first, then re-pay, so a claim already made never goes stale.
  - **Payment dates:** a payment can't be dated before the purchase date, or before the expense's latest GST adjustment.
  - **Unnamed suppliers:** expenses without a supplier name are paid one at a time.
  - **Reports (#54):**
    - The cash moves on the payment date.
    - On the cash basis, the attributed input tax credit moves on the payment date too.
    - A void reverses on the void day. Its correction is dated on its own `adjusted_on`.
    - Allocations and corrections post to `gst_source_postings` like bill payments, and payment dates follow the same date-ordering check.
  - A supplier-credit reversal cancels the balance. It's refused while live payments are allocated, so void them first. Payments and reversals take the same expense row lock, so whichever comes first wins.
  - A cost-only reversal leaves the supplier balance payable.
- Subcontractor bills (#139): a subcontractor submits their own tax invoice for one of their accepted offers (`subcontractor_bill_submissions` and its items).
  - **Submitting:** the subcontractor attaches a tax invoice or receipt they uploaded themselves, and the lines must be valid for their current GST registration. One pending submission is allowed per invoice number, with at most 20 pending per contractor. An invoice number already recorded as a bill is refused.
  - **Deciding:** the office decides once (`bill.write`), and a trigger prevents edits, deletes, a second decision, or lines added afterwards. The office queue shows the agreed offer amount and what's already billed against it. Approval needs the reviewer to confirm the invoice's lines, GST and total match the attached tax invoice.
    - Approval records the supplier bill through the same path as an office bill (#46): it uses the contractor's details, the offer link, and the office's evidence check and creditable share. The reviewer can set a partial claimable share, with a reason. GST lines are re-checked against the contractor's registration at that moment. The new bill is linked as `bill_id`. The approval note stays internal, as the bill's note.
    - Rejection needs a note, and the subcontractor can then resubmit.
  - **What the subcontractor sees:** only their own invoice, its status and the office's note. Never the job price, committed cost, or the bill's job cost or GST snapshot (T03).
  - **Documents:** a document stays with its submission, even a rejected one. It can't back an expense, another bill or a credit, and a resubmission uses a new upload. The cleanup of unattached uploads (#137) treats it as attached.
- Supplier credits (#140): an adjustment note against one bill. It snapshots the creditable GST it takes back, its non-creditable GST and the job cost it removes, all at the bill's own creditable share and worked out on the cumulative credited GST.
  - **Non-cash basis:** for the purchaser, the creditable GST taken back is an *increasing* adjustment (s19-80; ATO "reduction in purchase price"). It's made whether or not a note is held, and is dated the later of the issue date and `received_on`.
  - **Voids:** voiding a credit is a reversal dated on the void (`voided_at`, in Sydney time). It never rewrites the earlier period.
  - **Overcredit:** a credit can't take the bill's ex-GST amount, its GST, or what's still owing below zero. One live credit is allowed per supplier note reference on a bill.
  - **Credits on paid bills:** money already paid comes back as a supplier refund, which isn't built yet. Until then, a credit on a fully paid bill can't be recorded, and the accountant must adjust it on the BAS manually.
  - **Cash basis:** a bill's payments attribute against the net bill (incl GST − live credits). A credit, or its void, writes an append-only `supplier_credit_gst_adjustments` row when that changes what's attributed. The row is dated the latest of these: the credit's issue date, its received date, the GST posting date of the last live payment (`gst_source_postings.effective_on`, which is later than the payment date when the payment was entered late) and any earlier correction on the bill. On the cash basis, a supplier payment can't be dated before the bill's latest live credit or GST correction, which matches the rule for receipts (#54). A void's row is dated the day of the void. A row that *raises* the claim is, for the purchaser, a decreasing adjustment (the s19-80 credit itself is increasing), and needs a verified adjustment note when that adjustment is over $75.
  - **Bills:** a bill with live credits can't be voided. Commitments from accepted offers follow the gross bill.
  - **Reports (#54):**
    - A credit lowers the job cost on `received_on`.
    - On the non-cash basis, it lowers 1B on that date.
    - On the cash basis, only its recorded adjustment rows count.
    - A void reverses on the void day.
    - Credits and their adjustment rows are GST sources with a `gst_source_postings` row. One dated inside a finalised period posts to the current open period, so a finalised period never changes.
- Draft net GST = GST on sales (1A) - creditable GST on purchases (1B) ± adjustments, attributed per the company's accounting basis. This is a liability/asset, not profit.
- Cash movement = receipts minus payments, **not** profit.
- Do not count both timesheet and derived cost; link underlying record to cost once.
- No issued financial record deletion; use auditable reversal/credit/void.

## Worked test (GST-exclusive / not registered)
Invoice 250000 cents; contractor 90000; employee 30000; materials 15000; travel 10000. Costs 145000; profit 105000 (42%). Customer receipt 100000 leaves 150000 due. Contractor payment 40000 leaves 50000 due; neither modifies profit.

The GST-registered variant of this test is in [GST.md](GST.md#combined-gst-and-profit-acceptance-fixture); both variants must pass.

## Required tests
Partial/multiple payment allocations, retries and concurrency, zero/negative values and large numbers, void after receipt, refunds, credits, rate change historical preservation, incorrect tenant IDs, end-of-month reporting, filtering and sum reconciliation. GST: mixed codes, ex/incl entry, rounding boundaries, non-creditable GST in cost, registration-date boundaries, cash vs non-cash attribution, locked periods — always asserted together with the job-profit result.

## Implemented foundation

The #12 tenancy models, constraints, index rationale, ER diagram and migration
verification are documented in [core tenancy](testing/core-tenancy.md). Business
tables listed above remain planned until their milestone implementation.


## Customer primary contacts (#113)

Customer writes hold the parent customer's row lock. Promoting a contact demotes each
other primary in the same transaction and writes an individual audit event containing
`isPrimary: true → false`. Archiving clears the primary flag; archived contacts cannot
be promoted until restored. A partial unique SQL index on `(company_id, customer_id)`
where `is_primary AND archived_at IS NULL` also rejects competing active primaries
from direct database writes. The additive migration refuses inconsistent existing data
rather than silently repairing it; its test-only rollback removes only that index.

## Contractor offers and committed cost (#35)

- `contractors`: company-scoped, archived not deleted. `gst_registered` requires an ABN (CHECK). An optional link to an active **subcontractor** login of the same company is unique per company.
- `contractor_offers`: fixed price or hourly rate (`rate_exclusive_cents`, GST-exclusive) plus estimated hours in hundredths for hourly offers, and a `tax_code`. Only one open-or-accepted offer is allowed per contractor per job (partial unique index). A trigger refuses deletes, any change once the offer is accepted, declined or withdrawn, and any change to its terms when it is closed.
- `contractor_acceptances`: append-only, one per offer, with a composite FK to the offer's own job and contractor. Accepting snapshots the rate, hours, tax code, GST rate, exclusive/GST/inclusive amounts, both parties' GST registration, and **`committed_cost_cents`** = exclusive + non-creditable GST (creditable GST is never cost). The company's registration is read for the Sydney business date of acceptance.
- Committed cost is recorded once, at acceptance. Bills linked to an acceptance (supplier bills, M3) reduce the outstanding commitment and enter incurred cost, so the same work is never counted twice. `jobCostExposure` in `@jobflow/domain` computes it, and the combined fixture is asserted in `packages/domain/test/contractors.test.ts`: 90000 committed, then billed, gives cost 145000 and profit 105000, not 235000. Profit uses incurred cost only.
- Subcontractors see only offers to their own linked record, with the job's reference, title, status and due date, never the job price, committed cost or other contractors' rates.

## Expenses (#40)

- `expenses`: an expense for a job, or a general one (`job_id` null; office only). It has a category (materials, travel, parking, equipment, misc) and is entered GST-exclusive or GST-inclusive. The tax code and GST rate snapshot sit alongside the exclusive/GST/inclusive cents, plus a business-use `creditable_basis_points` and an optional receipt document (kind receipt or tax_invoice, unique per expense).
- **Settlement** (owner requirement): `paid_at_purchase` records `paid_on` and `payment_method` once, on the expense itself. `on_account` records neither and is owed to the supplier until supplier payments (M3) settle it. The default comes from `companies.default_expense_settlement`. Settlement never changes cost. Over approved expenses, cash paid + supplier outstanding = the GST-inclusive total (`expenseTotals`).
- **Approval** snapshots once: the company's GST registration on the purchase date; whether the approver **verified** the attached document (`evidence_verified`, audited, never inferred); whether that is qualifying evidence (`has_evidence`: a verified tax invoice above 8250 cents including GST, or a verified retained receipt at or below it, per R5/R6; no document means no evidence); creditable GST; non-creditable GST; and `job_cost_cents` = exclusive + non-creditable GST. CHECK constraints keep the snapshot consistent and present only when the expense is approved. Submitted and rejected expenses are not incurred cost.
- **Final once decided:** a trigger refuses deletes, any change to an approved or rejected expense, and any change to what was submitted while deciding it. A correction is an approved **reversal** row (`reverses_id`, unique) carrying the original's exact negated cents and snapshot. A reversal corrects **cost and GST only** (`settlement` null) unless an actual **refund** (paid expenses, with its date and method) or **supplier credit** (on-account expenses) is recorded with it. A cost correction never invents cash movement.
- Employees submit only for jobs they are live-assigned to, and see their own submissions without the approval snapshot. Only the submitter edits a submitted expense.

## Employee cost rates and timesheets (#38)

- `employee_rate_history`: an internal hourly cost (integer cents, $0–$1m) per employee from an `effective_from` date. It's **append-only** (trigger), with one rate per start date; a correction is a new start date. There's no payroll, super or PAYG: this is a management cost rate only.
- `timesheets`: minutes (1–1440) on a work date for a job, optionally one of its visits (composite FK, so the visit belongs to that job). Only an employee **live-assigned** to the job (or, for a visit-only assignment, to that visit) can submit, and never for a cancelled visit or a future date. Eligibility is re-checked inside the write transaction after taking #32's locks (job, then employee).
- **Approval** snapshots the rate in effect on the work date (`rate_id`, `hourly_cost_cents`) and `cost_cents` = round(minutes × rate / 60) **once**. A rate added later, even backdated, never changes an approved timesheet. With no rate on the work date, approval is refused (409) rather than guessed. Labour carries no GST, so it enters job cost as an internal cost.
- **Never counted twice:** a decided timesheet is frozen by a trigger (no edits, no deletes); a correction is an approved reversal with negated minutes and cost at the same snapshotted rate (unique per timesheet). Job labour is the sum of `cost_cents` over approved rows.
- Visibility: employees see their own timesheets without rate or cost. The office list needs `timesheet.approve`; rates and costs additionally need `employee.cost_rate.read` (owner, manager).

