# Money safety suite (#52)

`tests/integration/money-safety.test.ts` runs against a committed (real,
concurrent) PostgreSQL database through the same route handlers the app
uses. Every case asserts the **balances** (invoice received/outstanding,
bill paid/outstanding) **and the job's profit**. Profit is rebuilt from the
records as R10 defines it: invoiced revenue ex GST net of issued credit notes,
minus incurred job cost (ex GST plus non-creditable GST). Payments,
receipts, refunds and their voids must never change it.

| Area | Cases |
|---|---|
| Duplicate submissions | 5 concurrent copies of one receipt or one supplier payment record exactly one; a reused key with a different body is refused; missing or malformed keys are refused |
| Races | 3 full receipts racing for one invoice and 3 full payments racing for one bill: exactly one wins and nothing is overpaid; a payment racing its bill's void never leaves live money on a void bill |
| Amounts | zero, negative, fractional, exponent and over-limit amounts; totals that don't match their allocations; empty or duplicate allocations; negative bill lines and GST that isn't 10%; overpayment by one cent |
| Corrections | voiding a receipt restores the balance (and can't be repeated); an invoice with a live receipt can't be voided until the receipt is; voiding a payment re-opens its bill, and a paid bill can't be voided until then; a credit note lowers what's owed and revenue, and receipts can't exceed the remainder; refunds are capped at what was received, and voiding a refund restores it |

Run it alone: `pnpm test:integration tests/integration/money-safety.test.ts`.
It ran 3 times in a row with no failures. CI runs it in `pnpm test:integration`.
