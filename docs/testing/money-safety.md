# Money safety suite (#52)

Two integration files exercise money handling. Both drive the real route
handlers against a committed (real, concurrent) PostgreSQL database, and
every case asserts the **balances** and the **job's profit**.

- `tests/integration/money-safety.test.ts`: duplicates, races, amounts and
  corrections, document by document.
- `tests/integration/financial-safety.test.ts`: one job across every money
  module (invoices, receipts, credit notes, refunds, bills, payments,
  expenses and labour), plus cross-module races. It was ported from #154.

Profit is rebuilt from the stored records with the domain `jobProfit` (R10).
Revenue is GST-exclusive: issued invoices less issued credit notes. Cost is
`job_cost_cents` of live bills and approved expenses, plus the `cost_cents`
of approved timesheets. Recoverable GST can't reach profit; non-creditable
GST does, through job cost. Receipts, refunds, payments and their voids must
never move profit. When the M4 profit projection (#54) lands, assert it
against this oracle.

## money-safety.test.ts

| Area | Cases |
|---|---|
| Duplicate submissions | Five concurrent copies of one receipt or one supplier payment record exactly one. A reused key with a different body is refused. Missing or malformed keys are refused. |
| Races | Three full receipts racing for one invoice, or three full payments racing for one bill: exactly one wins and nothing is overpaid. A payment racing its bill's void: exactly one wins, and the balance and cost follow the winner (three rounds). Two refunds that each fit but together exceed what was received: one is refused. |
| Amounts | Zero, negative, fractional, exponent and over-limit amounts. Totals that don't match their allocations. Empty or duplicate allocations. Negative bill lines and GST that isn't 10%. Overpayment by one cent. |
| Corrections | Voiding a receipt restores the balance, and it can't be voided twice. An invoice with a live receipt can't be voided until the receipt is. Voiding a payment re-opens its bill, and a paid bill can't be voided before then. A credit note lowers both what's owed and revenue, and receipts can't exceed the remainder. Refunds are capped at what was received, and voiding a refund restores it. |

## financial-safety.test.ts

| Case | What it proves |
|---|---|
| Lifecycle on one job | A concurrent retried receipt lands once. A credit after full payment leaves an overpayment that only an exact refund clears. A supplier payment and its void move the bill only. A half-creditable expense puts its non-creditable GST into cost. Concurrent expense reversals, timesheet approvals and timesheet reversals each apply once. Profit is asserted after every step. |
| Concurrent issue | Issuing one draft three times at once gives one 200, one number, and revenue counted once. |
| Racing credit notes | Of two credits that together exceed the invoice, one issues and one is refused. |
| Invoice void vs receipt | Exactly one wins: either the invoice is void with no allocation, or it is paid and the void is refused. Runs three rounds. |
| Bill void vs payment | Exactly one wins, and cost follows the bill. Runs three rounds. |
| Bad amounts | Zero, negative (number and string), fractional, exponent and over-13-digit amounts are refused on receipts, refunds, supplier payments, bill lines, expenses and invoice lines, as is a bill over the $10bn ceiling. No rows, balances or profit change. |

## Running

`pnpm test:integration tests/integration/money-safety.test.ts tests/integration/financial-safety.test.ts`

CI runs both as part of `pnpm test:integration`.
