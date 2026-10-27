# Accountant review pack (#67)

**For:** the accountant or registered tax agent reviewing JobFlow's GST handling before it's used with real data,
and the owner who records their sign-off.

JobFlow calculates GST, issues tax invoices and prepares a **draft** GST/BAS summary for the accountant. It does
not lodge anything with the ATO, and it does no payroll, super, PAYG or STP. This pack shows exactly what JobFlow
produces for one worked job, so you can confirm the treatment or tell us what to change.

All data in this pack is synthetic. ABNs are test numbers, and names are invented.

## What's in the pack

The samples come from one job, built through the app's own code, in three set-ups:

| Folder | Company set-up |
|---|---|
| `registered-accrual/` | GST-registered, non-cash (accruals) basis |
| `registered-cash/` | GST-registered, cash basis |
| `not-registered/` | Not registered for GST |

Each folder holds:
- `invoice.pdf`: the customer invoice, exactly as a customer would receive it.
- `gst-summary.csv`: the draft BAS figures G1, 1A, 1B and net GST.
- `gst-lines.csv`: every transaction behind 1A and 1B, with its date, source and GST.
- `profitability.csv`: job revenue, cost and gross profit.
- `ageing-receivables.csv` and `ageing-payables.csv`: who owes what at 31 July 2026.

Money in the CSVs is in **whole cents** (`9091` means $90.91), so nothing is lost to rounding when the files
are imported. JobFlow keeps cents throughout; dropping cents for BAS presentation is left to you.

**To regenerate it** (the owner or a developer), from the repository root with the test database running:

```sh
ACCOUNTANT_PACK_DIR=accountant-pack pnpm test:integration tests/integration/accountant-pack.test.ts
```

The same test runs in CI on every change and fails if any figure below changes.

## The worked job

One bathroom renovation in July 2026 (quarter 1 July to 30 September 2026):

| Item | Ex GST | GST | Incl GST | Treatment |
|---|---|---|---|---|
| Customer tax invoice, issued 15 Jul | $2,500.00 | $250.00 | $2,750.00 | Taxable sale (10%) |
| Subcontractor bill, tax invoice held, 15 Jul | $900.00 | $90.00 | $990.00 | GST fully creditable |
| Employee labour, 5 h at $60 | $300.00 | — | — | Internal cost, no GST |
| Materials, tax invoice held, paid 15 Jul | $150.00 | $15.00 | $165.00 | GST fully creditable |
| Travel, paid 15 Jul | $100.00 | $0.00 | $100.00 | No GST charged |
| Customer pays $1,000.00 on 20 Jul | | | | Part payment |
| JobFlow pays the subcontractor $400.00 on 20 Jul | | | | Part payment |

When not registered, the same prices are used as totals: the sale is $2,500.00 and no GST is charged or claimed.

## What JobFlow produces

| | Registered, accruals | Registered, cash | Not registered |
|---|---|---|---|
| Invoice title | Tax Invoice | Tax Invoice | Invoice |
| Invoice total | $2,750.00 | $2,750.00 | $2,500.00 |
| **G1** total sales (incl GST) | $2,750.00 | $1,000.00 | $0.00 |
| **1A** GST on sales | $250.00 | $90.91 | $0.00 |
| **1B** GST on purchases | $105.00 | $51.36 | $0.00 |
| Net GST payable | $145.00 | $39.55 | $0.00 |
| Job revenue (ex GST) | $2,500.00 | $2,500.00 | $2,500.00 |
| Job cost | $1,450.00 | $1,450.00 | $1,450.00 |
| Gross profit (margin) | $1,050.00 (42%) | $1,050.00 (42%) | $1,050.00 (42%) |
| Customer still owes | $1,750.00 | $1,750.00 | $1,500.00 |
| JobFlow still owes the subcontractor | $590.00 | $590.00 | $500.00 |

How the figures are worked out:
- **Accruals:** GST is reported in the period of the invoice or bill, so the full $250.00 and $90.00 + $15.00 count in July.
- **Cash basis:** GST is reported as money changes hands.
  - 1A is 1/11 of the $1,000.00 received, which is $90.91.
  - 1B is 1/11 of the $400.00 paid, which is $36.36, plus the $15.00 on materials paid in full at purchase.
  - When the rest is paid, JobFlow reports the exact remainder, so the total never exceeds the GST on the invoice.
- **Profit never includes recoverable GST.** It's the same in all three set-ups. Only GST that can't be claimed
  (for example, a purchase without a tax invoice yet) is added to job cost.

## Questions for you

Please confirm each, or tell us what the right treatment is.

1. **Cash-basis G1.** On the cash basis, G1 shows only what was received in the period ($1,000.00), not the
   invoice total. Is that right for your clients?
2. **Cash-basis rounding.** JobFlow takes 1/11 of the cumulative amount received, rounds half up, and subtracts
   what it already reported. The last payment releases the exact remainder. Is this acceptable?
3. **Mixed invoices.** When an invoice has taxable and GST-free lines, a part payment is split across the lines in
   proportion to their totals. Is that acceptable, or should payments be allocated line by line?
4. **Purchases with no GST.** Travel with no GST shows on the GST lines as a $0.00 line under 1B. Do you want
   out-of-scope and GST-free purchases left off the GST lines instead?
5. **Missing tax invoice.** A purchase over $82.50 without a tax invoice has its GST treated as job cost, not
   claimed. The planned next step (#142, not yet released) is this: when the tax invoice arrives, JobFlow claims the
   GST in that period and takes it back out of cost, with an audit record. Is that right?
6. **Part business use.** A purchase can be marked as partly creditable (for example 50%), with a reason. Is a
   simple percentage enough, or do you need another method?
7. **Credit notes and voids.** Credits and voids are reported in the period they happen. Corrections to a
   finalised period are posted to the current open period, and the original stays unchanged. Is that right?
8. **Registration changes.** JobFlow records a registration start date and basis. It sends backdated registration,
   cancellation and basis changes to you rather than handling them itself. Is that the right boundary?
9. **Tax invoice contents.** Does the sample `invoice.pdf` meet the tax invoice requirements? It is $2,750.00, so it
   shows the customer's identity.
10. **Anything missing.** Is there a BAS label or report you would need that isn't here? For example G2, G3,
    G10 or G11, which JobFlow doesn't produce.

The rules behind these answers, with ATO references, are in [domain-gst-profit.md](domain-gst-profit.md).

## Sign-off

The owner records this on issue #67. Corrections go in as new issues and are fixed before real use.

| | |
|---|---|
| Reviewer name | |
| Registration (tax agent or CA/CPA number) | |
| Date reviewed | |
| Pack version (commit) | |
| Outcome | Approved / Approved with corrections / Not approved |
| Corrections (issue numbers) | |
