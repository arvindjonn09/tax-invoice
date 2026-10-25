# Payments: supplier bills, supplier payments and customer receipts

**Payments** has three views:
- **Supplier bills:** what you owe suppliers and contractors.
- **Supplier payments:** money you paid out.
- **Customer receipts:** money you received.

Owners and accountants record bills and payments, and managers can see them.

## Supplier bills

1. Go to **Payments**, then **Record bill**.
2. Choose who the bill is from:
   - **A contractor:** their name, ABN and GST status come from their contractor record.
   - **Any other supplier:** enter the name, whether they're registered for GST, and their ABN if they are.
3. Enter the **Supplier's bill number**, the **Bill date** and an optional **Due date**.
4. Add lines, each with an amount ex GST, the GST shown on the bill, and the GST treatment.
5. Attach the **Supplier's document** (photo or PDF). Tick that you checked it's a valid tax invoice. JobFlow only claims the GST credit when there's verified evidence, as the ATO rules require.
6. If only part of the GST is claimable (private use, say), set the **Business-use share** and say why.

The bill shows:
- **Job cost:** ex GST plus any GST you can't claim.
- **Claimable GST credit.**
- **Still owing.**

A recorded bill can't be edited. Void it with a reason if it was a mistake (unpaid bills only), or record a supplier credit.

### Supplier credits

When a supplier sends a credit note (an adjustment note) for a bill, record it against the bill. It lowers what you owe, the job cost and the GST credit. You can't credit more than is still owing. If the bill is already fully paid, adjust it with your accountant.

> The screen for recording supplier credits is still to come. For now, they're recorded through the API (`POST /api/bills/<id>/credits`), so ask whoever administers JobFlow.

### Invoices from subcontractors

Subcontractors with portal access can send their own tax invoice from the work you offered them. Those invoices wait under **Subcontractor invoices to review** at the top of **Supplier bills**. For each one:
1. Use **Open tax invoice** and check it.
2. Tick **I checked invoice … it's a valid tax invoice and its lines, GST and total match**. If only part of the GST is claimable, enter the claimable share and why.
3. Choose **Approve and record bill**. This records the bill exactly as if you'd entered it.

Or write a note and choose **Send back**. The subcontractor sees your note and can send a corrected invoice.

Subcontractors never see the job's price, your costs or your profit.

## Supplier payments

1. Go to **Payments**, then **Record payment**.
2. Choose who you **Paid**, the date, the **Method** and the amount.
3. Allocate the amount across that supplier's bills.
4. Save. Each payment has a one-time key, so pressing save twice never records it twice.

> Expenses bought **on account** can be paid through supplier payments too, but not in the same payment as bills. That isn't on the payment screen yet, so for now it's done through the API.

A payment can't be edited. Void it with a reason, and its bills become owing again. On the cash basis, a payment can't be dated before the bill's latest credit or GST correction.

## Customer receipts

1. Go to **Payments**, then **Record receipt**.
2. Choose the customer, the date, the method and the amount.
3. Allocate it to their issued invoices. A refund is recorded the same way, as a refund.

Voiding a receipt re-opens the invoices it paid.

## What counts where

- **Profit:** uses ex GST amounts only. GST you can claim back is never income or cost.
- **Cash position:** is money received minus money paid. That isn't profit.
- **GST:** depends on your basis.
  - **Non-cash:** GST counts when the invoice or bill is dated.
  - **Cash:** GST counts as it's paid or received.

  See [gst.md](gst.md).
