# Australian GST implementation (version 1)

## Scope and compliance boundary
Implement GST calculation and BAS **draft support**, not automated BAS lodgement or tax advice. An accountant must validate outputs before lodging. No superannuation, STP, PAYG withholding or employee payroll engine. Use the ATO's current published requirements as the reference, and review as regulations change.

## Company configuration
- Business legal name, ABN, business address, GST registered boolean, effective registration start/end dates.
- GST accounting basis: CASH or NON_CASH (accrual); effective-dated and locked after a period is finalised.
- BAS reporting period configuration and financial period lock/finalisation; GST number format and liability reporting.
- A company **not registered for GST must not charge GST** and must issue an 'Invoice', not a 'Tax Invoice'. Use GST 0 with distinct out-of-scope/unregistered classification.

## Tax treatment per line
- TAXABLE_10: ordinarily 10% tax on GST-exclusive amount.
- GST_FREE: 0%, separately classified.
- INPUT_TAXED: 0%, generally no input tax credits on related acquisitions; eligibility depends on activity.
- OUT_OF_SCOPE: 0%, separate from GST-free.
- Store tax code, percentage snapshot, exclusive amount, tax amount, inclusive amount and rounding adjustments on each invoice/bill line.
- Support mixed-tax invoices, GST-inclusive and exclusive entry modes, credit notes and correcting/reversing entries. Store original issued snapshots.
- Money stored integer cents; define rounding consistently at invoice/line level and test edge cases. Do not assume all purchases permit full input-tax credits.
- Supplier bills: supplier ABN, GST registration verification status (manual/ABN Lookup later), tax invoice file, input-credit eligibility fraction and creditable GST. A GST amount on a bill is not automatically creditable.

## Invoice compliance
When registered and a taxable supply is made, issue a 'Tax Invoice' with supplier identity and ABN, date, description and quantity if applicable, total price, GST payable (or sufficient indication), taxability, and recipient identity/ABN on invoices >= AUD 1000. Use ATO current thresholds and guidance. Unregistered companies issue ordinary invoices without a GST charge.
- Validate required fields **before issue**, preserve sequential invoice reference and PDF snapshot.
- Support customer invoice lines with taxable, GST-free, input-taxed and out-of-scope status.
- Receipts must allocate across invoices/lines accurately for mixed GST treatment and partial payment.

## Reporting
- G1 sales, 1A GST on sales, 1B eligible GST on purchases, plus supporting transaction drill-down and adjustment registers. GST net estimate = 1A - 1B, subject to adjustments and actual reporting basis.
- Cash basis: attribute tax proportionately to payments; non-cash basis: generally attribute to earliest invoice/payment under relevant rules. Correctly handle partial payments, refunds and credits.
- Exclude periods before GST registration as applicable; financial period close/lock, corrections and amended reports without deleting history.
- Provide CSV/PDF accountant export and a clear 'Draft BAS/GST summary, not lodged' label.
- Do not equate GST turnover with profit. **Recoverable GST is never revenue, profit or expense.** Job profit uses GST-exclusive amounts; only non-creditable GST is part of job cost.

## GST and profitability are one unit
GST calculation and job profitability share one domain package and one set of fixtures, and are developed, reviewed and tested together. A change to either must run both the GST fixtures and the profit fixtures, in GST-registered and not-registered variants.

## Acceptance fixtures
1. Taxable customer invoice AUD 2000 ex GST → 200 GST → total 2200.
2. Creditable contractor bill AUD 800 ex GST → 80 GST → total 880.
3. Other job expense AUD 200 with no recoverable GST.
4. Gross job profit: 2000 - 800 - 200 = AUD 1000.
5. If all tax amounts attributable to same period, sales GST 200, eligible purchase credit 80, indicative net GST 120.
6. On cash accounting, a AUD 1100 payment against a solely taxable AUD 2200 invoice attributes AUD 100 GST to that payment (assuming no adjustments).
7. Company not GST registered → no GST charged, PDF titled 'Invoice'.
8. Mixed GST codes, GST-free lines, input-taxed expenses, GST registration date, credit/void/refund, partial supplier payment, rounding boundaries, concurrency and report period locking have automated tests.

## Combined GST and profit acceptance fixture
The core fixture from the README, for a **GST-registered** company. Amounts are GST-exclusive unless stated. (Status: proposed — to be verified against ATO guidance by the domain-expert before implementation.)

| Item | Ex GST | GST | Incl GST | Creditable GST | Job cost |
|---|---|---|---|---|---|
| Customer tax invoice (TAXABLE_10) | 2,500.00 | 250.00 | 2,750.00 | — | — |
| Subcontractor bill, valid tax invoice | 900.00 | 90.00 | 990.00 | 90.00 | 900.00 |
| Employee labour (internal cost, no GST) | 300.00 | — | — | — | 300.00 |
| Materials, valid tax invoice | 150.00 | 15.00 | 165.00 | 15.00 | 150.00 |
| Travel (no GST charged) | 100.00 | 0.00 | 100.00 | — | 100.00 |

Expected:
- Job cost **$1,450.00**; gross profit **$1,050.00**; margin **42%** — identical to the not-registered variant. GST does not change profit.
- Draft GST (same period, non-cash basis): 1A $250.00; 1B $105.00; indicative net GST payable $145.00.
- Receipt of $1,000.00 → customer outstanding **$1,750.00** (GST-inclusive). Profit unchanged.
- Payment of $400.00 against the $990.00 subcontractor bill → supplier outstanding **$590.00**. Job cost and profit unchanged.
- Cash basis: the $1,000.00 receipt attributes 1/11 of the receipt to 1A (≈ $90.91); the exact rounding rule must be pinned by the domain-expert and tested.
- Non-creditable variant: if the materials purchase has no valid tax invoice / is not creditable, its $15.00 GST becomes cost → job cost $1,465.00, profit $1,035.00, 1B $90.00.
- Not-registered company: no GST charged, document titled "Invoice", all figures as in the README fixture.

## Official references
- https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst
- https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business
- https://www.ato.gov.au/api/public/content/0-53cc7a8e-0668-4c9d-95d7-eb841eb09c04
