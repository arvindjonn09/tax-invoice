# GST and job-profit implementation contract

Verified 22 October 2026 against the ATO sources below. This is the M0 research hand-off for #16,
not accountant approval or a financial implementation. All example amounts are AUD integer cents.

## Source register

Retrieved 22 October 2026. Some ATO full-page requests returned HTTP 403; search-index extracts of
the identified ATO publications were available. Review the current consolidated ruling before production.

- S1: [ATO tax-invoice ruling GSTR 2013/1](https://www.ato.gov.au/law/view/document?docid=GST/GSTR20131/NAT/ATO/00001), tax-invoice contents and low-value exception.
- S2: [ATO GST Act section 29-70](https://www.ato.gov.au/law/view/document?LocID=%22PAC%2F19990055%2F29-70%282%29%22), recipient threshold and issue deadlines.
- S3: [ATO accounting and rounding guidance](https://www.ato.gov.au/api/public/content/0-1e92db95-a75c-4f4e-a3d4-39f43b1a3b25), taxable sales, rounding and credits.
- S4: [ATO GSTR 2000/13](https://www.ato.gov.au/law/view/document?docid=GST/GSTR200013/NAT/ATO/00001), paragraphs 12–17, cash/non-cash attribution and registration.
- S5: [ATO GSTR 2000/12](https://www.ato.gov.au/law/view/document?docid=GST/GSTR200012/NAT/ATO/00001), paragraphs 23–27, tax-invoice timing and adjustment events.
- S6: [ATO GSTR 2013/2](https://www.ato.gov.au/law/view/document?docid=GST/GSTR20132/NAT/ATO/00001), adjustment notes.
- S7: [ATO PS LA 2011/8](https://www.ato.gov.au/law/view/document?docid=PSR/PS20118/NAT/ATO/00001), registration effective dates.
- S8: [ATO business changes or cessation](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/if-your-business-changes-or-ceases), cancellation and final-period treatment.
- S9: [ATO GST credits](https://smallbusiness.taxsuperandyou.gov.au/goods-and-services-tax/what-are-gst-credits), eligibility, supporting documents and exclusions.

## Glossary

GST-exclusive means price without GST; GST-inclusive means price plus GST. Input tax credit means
recoverable purchase GST. Creditable purpose is eligible business use, generally excluding private
use and acquisitions relating to input-taxed supplies. Attribution assigns GST to a tax period;
it does not define job profit. An adjustment note documents a change to a previously taxed supply.

## Numbered rules

Each source reference uses the retrieval date in the source register. Product decisions are explicitly
identified; they are not claims that the ATO prescribes JobFlow's accounting model.

- **R1 — registration:** snapshot the effective registration state. An ordinary unregistered business
  charges no GST and issues an Invoice. Being required to register cannot be overridden by a UI
  checkbox: overdue registration, backdating and cancellation require accountant review. Do not
  drop receipts of existing taxed invoices merely because registration subsequently ceased. [S4, S7, S8]
- **R2 — tax codes:** taxable supplies ordinarily use 10%; GST-free and input-taxed supplies carry
  no sales GST but remain distinct. Out-of-scope is a separate product classification. Do not infer
  credit eligibility solely from the purchase tax code. [S3, S9]
- **R3 — rounding:** JobFlow selects per-taxable-supply rounding, with one supply represented by
  each line; aggregate a line's quantity and price before rounding. Round positive fractional GST
  cents to nearest cent, half upwards. Exclusive entry: tax = round(exclusive cents / 10), inclusive
  = exclusive + tax. Inclusive entry: tax = round(inclusive cents / 11), exclusive = inclusive − tax.
  Sum rounded line values for invoice totals. Do not mix this with rounding the unrounded tax of
  the whole invoice. Supplier invoices retain the supplier's actual GST and documented rounding
  convention; never rewrite a valid supplier invoice to match ours. Integer rational arithmetic
  only. This is a product choice among ATO rounding conventions. [S3]
- **R4 — tax-invoice contents:** clearly identify the document as a tax invoice, seller identity,
  seller ABN, issue date, description, quantity if applicable, price, GST payable and extent of
  taxability. A total-includes-GST statement alone suffices only when GST is exactly one eleventh
  of total price; mixed-tax documents show taxable treatment and GST explicitly. At total price
  **100000 cents or more**, recipient identity **or** recipient ABN is required, not necessarily
  both. Sequential references and PDF snapshots are additional JobFlow audit rules. [S1, S2]
- **R5 — low-value purchases:** a tax invoice is generally needed to claim credits for a purchase
  **over 8250 cents including GST**; exactly 8250 falls within the low-value exception. Retain
  alternative purchase evidence. JobFlow will issue compliant invoices for all its taxable sales,
  avoiding a threshold-dependent issue workflow; for requests subject to the statutory obligation,
  supply within 28 days. Do not confuse this threshold with R4's recipient threshold. [S1, S2, S9]
- **R6 — eligibility:** credit only GST actually included on eligible acquisitions by a registered
  business, paid or liable to be paid, with required evidence. No credit for wages, GST-free or
  input-taxed purchases, private use or generally purchases relating to input-taxed sales. Partial
  eligible business use requires a recorded rational fraction and reason. Missing evidence defers
  a claim; it need not permanently destroy entitlement. Product policy: provisionally include
  unclaimable GST in job cost until evidence/eligibility is approved, then post an audited
  reclassification; never silently rewrite an approved cost. [S3, S5, S9]
- **R7 — cash attribution:** attribute only to consideration received/paid in the period, subject
  to evidence for credits. Product cent policy: round cumulative allocated eligible tax, then
  subtract previously attributed tax, capped at the invoice's tax; final settlement releases the
  exact residual. For mixed-tax lines allocate consideration explicitly or proportionally with
  a deterministic largest-remainder cent allocation and immutable line-ID tie break. A blanket
  receipt / 11 is valid only for an entirely 10%-taxable invoice. This allocation/cent policy is
  JobFlow's reconciliation choice and needs accountant confirmation. [S4, S5]
- **R8 — non-cash attribution:** generally attribute the full tax at the earlier of any consideration
  or invoice issue, not due date or full settlement. Purchase-credit attribution additionally
  requires the tax invoice to be held when the BAS is lodged (subject to exceptions); otherwise
  defer to the first qualifying period. Preserve invoice issue, receipt and evidence dates. [S4, S5]
- **R9 — adjustments:** cancellation, price change or changed taxability can create an adjustment.
  Preserve originals and link credit/reversal and adjustment evidence. Where required, issue an
  adjustment note within 28 days of the earlier qualifying request/awareness event; include
  supplier identity/ABN, issue date, reason, adjustment effect and sufficient original supply
  identification, plus recipient identity/ABN where the original total meets R4. Locked periods
  require accountant-directed adjustment or correction, not silent mutation. [S5, S6]
- **R10 — profit:** JobFlow's management gross profit is invoiced revenue excluding sales GST minus
  incurred exclusive costs plus non-creditable GST. Creditable GST is an asset, sales GST a
  liability. Payments settle balances and never create a second cost or alter gross profit.
  This product definition is consistent with the GST separation in ATO guidance; it is not an
  income-tax deductibility or statutory financial-reporting determination. [S3, S4, S9]

## Worked examples and test hand-off

| Case | Exact inputs (cents) | Expected outputs (cents unless noted) |
|---|---|---|
| Registered combined fixture, non-cash, same eligible period | Sale ex 250000; subcontractor ex 90000 + tax 9000; labour 30000; materials ex 15000 + tax 1500; travel 10000 | Sale tax 25000, total 275000; cost 145000; profit 105000; margin 42%; 1A 25000, 1B 10500, net 14500 |
| Registered settlements | Customer receipt 100000; supplier payment 40000 against total 99000 | Customer due 175000; supplier due 59000; profit 105000 |
| Not registered independent price fixture | Sale total 250000; costs 90000 + 30000 + 15000 + 10000; receipt 100000; supplier payment 40000 | GST 0; cost 145000; profit 105000; margin 42%; customer due 150000; supplier due 50000 |
| Materials non-creditable | Registered fixture; materials credit 0 | Cost 146500; profit 103500; 1B 9000; net 16000 |
| Materials 50% creditable | Registered fixture; materials credit 750 | Cost 145750; profit 104250; 1B 9750; net 15250 |
| Cash sale and subcontractor only | Receipt 100000 of 275000; payment 40000 of 99000; no materials payment | 1A 9091; 1B 3636; net 5455; profit 105000 |
| Cash residual settlement | Above receipt then remaining 175000 | Second sales attribution 15909; cumulative 25000, never 25001 |
| Exclusive half cent | Line ex 5 | Tax 1; total 6 |
| Exclusive two supplies | Two lines ex 5 each | Taxes 1 + 1 = 2; invoice total 12; whole-invoice rounding would give 1 and is not selected |
| Inclusive | Line total 100 | Tax 9; exclusive 91 |
| Mixed invoice | Taxable total 11000 + GST-free total 10000; receipt 10500 pro rata | Tax 1000; exclusive revenue 20000; cash tax 500, not 955 |
| Full credit note | Original sale ex 250000, tax 25000, no receipts | Credit ex 250000, tax 25000, total 275000; remaining balance 0; reverse revenue and GST once |

The not-registered fixture uses independent unchanged **total** prices. It does not assert that an
unregistered purchaser can recover supplier GST: if the same supplier gross invoices 99000 and
16500 are used instead, cost is 155500 and profit 94500 on revenue 250000.

Boundary tests: totals 99999/100000 for recipient identity; purchase 8250/8251 for evidence;
registration before/on/after confirmed effective date, cancellation outstanding receipts,
GST-free/input-taxed mixed lines, no evidence then later evidence, fractional eligibility,
zero-revenue margin N/A, negative credits reversing original cents, full/partial refunds,
locked periods, and duplicate allocation rejection. Registration-spanning contracts, deposits,
retentions, bad debts and basis changes must be reviewed rather than handled by a naive invoice-date test.

## Accountant decisions before real use

Confirm cash cumulative rounding and mixed-line allocation; GST classification of actual activities
and travel; evidence-deferral cost reclassification; partial eligibility and private-use allocation;
registration/cancellation and basis-change transitional cases; special acquisition restrictions,
credit-note adjustment timing, BAS whole-dollar presentation and excluded G1 items. Keep ledger
cents and export cents even where BAS presentation drops cents. The fixture verifies ordinary
10% supplies with full business eligibility, valid evidence and no special rules; it is not a
universal claim that GST cannot affect profit.

## Delivery ownership

Architect: R1, R4, R6–R9 evidence and event snapshots. Backend #17: R2–R3, R6–R10 shared GST/profit
core and every worked example. QA: boundary cases plus registered/not-registered reconciliation.
M3 invoice and payment owners implement R4–R9 only after their dependencies. Accountant pilot
review remains M5; this research does not complete that checkpoint.
