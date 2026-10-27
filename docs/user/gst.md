# GST and the draft BAS summary

JobFlow works out GST and prepares a **draft** GST/BAS summary for your accountant. It does **not** lodge anything with the ATO. It also doesn't handle superannuation, PAYG withholding, Single Touch Payroll or payroll.

## Settings

Owners and accountants manage GST in **Settings**:
- **Registration periods:** when you were registered for GST, and from when you stopped, if you did. Documents dated outside a registration period charge and claim no GST.
- **Accounting basis:** cash or non-cash, for each period. Changing it affects only the documents dated in that period.

## What goes into the summary

| Label | What it is |
|---|---|
| G1 | Total sales including GST (out-of-scope lines excluded) |
| 1A | GST on sales |
| 1B | GST credits on purchases you can claim |

- **On the non-cash basis:** invoices and bills count when they're dated. Credit notes and supplier credits count when they're issued or received.
- **On the cash basis:** GST counts as money is received or paid, in proportion to the payment.
- **Corrections:** voids and corrections count on the day they happen. They never rewrite an earlier period.

## Closing a period

When your accountant has checked a period, an owner or accountant **closes** it. A closed period keeps its figures exactly. A late document dated inside it counts in the next open period instead. A correction to a closed period is recorded as an explicit adjustment with a reason, never as an edit.

## Where to see it

The report screens with filters and CSV export are still being built (#58). Until then, these endpoints return the same figures the screens will show:

- `GET /api/reports/gst?from=2026-07-01&to=2026-09-30` gives the draft summary. Owners and accountants only.
- `GET /api/reports/profitability?from=…&to=…` gives job profit ex GST, for anyone allowed to see job profit.
- `GET /api/reports/gst/periods` lists closed periods. Owners and accountants only.
- `POST /api/reports/gst/periods` closes a period. Owners and accountants only.

Always have your accountant review the draft before you lodge your BAS.
