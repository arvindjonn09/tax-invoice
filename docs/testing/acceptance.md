# Critical acceptance test (#59)

`tests/e2e/acceptance.spec.ts` runs the README's **CRITICAL ACCEPTANCE TEST** and the [combined GST and profit fixture](../GST.md#combined-gst-and-profit-acceptance-fixture) end to end through the running app, as the people who do each step:

| Step | Who | How |
|---|---|---|
| Customer, job priced at $2,500 ex GST | Owner | API |
| Subcontractor offer, $900 fixed | Owner | API |
| Accept the offer | Subcontractor | Portal API |
| Cost rate $60/h, assignment | Owner | API |
| 5 hours on the job (labour $300) | Employee | API |
| Approve the timesheet | Owner | API |
| Materials $150 (tax invoice attached and verified) and travel $100, paid at purchase | Owner | API, with real private uploads |
| Subcontractor's bill for the accepted offer | Owner | API |
| Customer invoice $2,500 ex GST, issued | Owner | API |
| Receipt $1,000; payment $400 to the subcontractor | Owner | API |

**Separate companies:** each variant gets its own synthetic company, created for the run. That keeps every figure exact even while other specs share the e2e company.

## Variants and expected values

| Variant | Job cost | Profit | Margin | Customer owes | Supplier owed | G1 / 1A / 1B / net |
|---|---|---|---|---|---|---|
| Not registered | $1,450 | $1,050 | 42% | $1,500 | $500 | 0 / 0 / 0 / 0 |
| Registered, non-cash | $1,450 | $1,050 | 42% | $1,750 | $590 | $2,750 / $250 / $105 / $145 |
| Registered, no tax invoice for the materials | $1,465 | $1,035 | 41.40% | $1,750 | $590 | $2,750 / $250 / $90 / $160 |
| Registered, cash basis | $1,450 | $1,050 | 42% | $1,750 | $590 | $1,000 / $90.91 / $51.36 / $39.55 |

**Cash-basis figures:**
- **1A** is 1/11 of the $1,000 receipt: 9091 cents (rule R7).
- **1B** is the materials' 1500 cents, paid at purchase, plus round(40000 × 9000 / 99000) = 3636 cents of GST on the $400 bill payment.

## What each variant checks

- **Profit before and after settlements:** profit is the same before and after the receipt and payment; payments never change profit.
- **Four sources agree:** the dashboard API, the report APIs (profitability, GST, ageing) and sums taken directly from the database all give the same figures.
- **On screen:** the dashboard and Reports screens show them too.
- **Negative cases from the README:**
  - A negative receipt and an overpaid receipt are refused (400).
  - An overpaid bill payment is refused (400).
  - The employee can't read reports, the dashboard, invoices or receipts, and can't record a receipt (403).
  - The same receipt or payment submitted twice with one idempotency key is recorded once.
  - A mistaken invoice that is issued and then voided leaves every figure unchanged.

## Running it

`pnpm test:e2e tests/e2e/acceptance.spec.ts`. It needs the disposable e2e database, plus private storage for the uploads, the same as CI.
