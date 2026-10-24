# Financial safety suite (#52)

`tests/integration/financial-safety.test.ts` drives the real route handlers
against PostgreSQL. Every case checks document balances (invoice received,
credited, outstanding and overpaid; bill paid and outstanding) and job profit.

Profit is computed from the ledger with the domain `jobProfit` (R10):
GST-exclusive revenue from issued invoices less issued credit notes, minus
`job_cost_cents` from live bills and approved expenses (reversals are approved
negative rows) and `cost_cents` from approved timesheets. Recoverable GST can't
reach it; non-creditable GST does, through `job_cost_cents`. When the M4 profit
projection (#54) lands, assert it against this oracle.

| Case | What it proves |
|---|---|
| Lifecycle on one job | Concurrent retried receipt lands once; credit after full payment leaves an overpayment that only an exact refund clears; supplier payment and its void move the bill only; a half-creditable expense puts its non-creditable GST into cost; concurrent expense reversals, timesheet approvals and timesheet reversals each apply once. Profit is asserted after every step. |
| Concurrent issue | Issuing one draft three times at once: one 200, one number, revenue once. |
| Racing credit notes | Two credits that together exceed the invoice: one issues, one is refused. |
| Invoice void vs receipt | Exactly one wins. Either the invoice is void with no allocation, or it is paid and the void is refused. Runs three rounds. |
| Bill void vs payment | Exactly one wins, and cost follows the bill. Runs three rounds. |
| Bad amounts | Zero, negative (number and string), fractional, exponent and over-13-digit amounts are refused on receipts, refunds, supplier payments, bill lines, expenses and invoice lines, as is a bill over the $10bn ceiling. No rows, balances or profit change. |

Not covered here: module-level duplicates, overpayment and void-ordering cases
already in `receipts`, `supplier-bills`, `invoices`, `expenses` and
`timesheets` integration tests.
