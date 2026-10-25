# Invoices and credit notes

This is for owners and accountants who bill customers. Managers can prepare drafts, but only an owner or accountant can issue them.

## Before your first invoice

In **Settings**, check:
- **Company profile:** legal name, ABN and address. These print on every tax invoice.
- **GST registration:** the date you registered, and whether you report on a **cash** or **non-cash** (accruals) basis. An invoice dated before your registration date is not a tax invoice and charges no GST.

## Create and issue an invoice

1. Go to **Invoices**, then **New invoice**.
2. Choose the **Customer**. Linking a **Job** and a service location is optional.
3. Add lines, each with:
   - a description
   - a quantity
   - a unit price, entered ex GST or incl GST (the **Prices entered** setting)
   - a **GST treatment**: taxable at 10%, GST-free, input-taxed or out of scope

   The totals show the subtotal, GST and total incl GST as you type.
4. **Save draft.** Drafts can be changed and deleted. They aren't sent and don't count anywhere.
5. **Review and issue.** JobFlow re-checks the totals on the server and shows any problems: a missing ABN, a customer without the details a large invoice needs, or the issue date. Issuing gives the invoice the next number and locks it.

An issued invoice can't be edited or deleted, because the Australian Taxation Office (ATO) expects records to stay as they were. To change one, credit it or void it.

## PDF

On an issued invoice, choose **Get PDF**. You get a private download link that expires after a short time. The PDF is generated once and stored, so the same invoice always gives the same document.

## Fix an issued invoice

- **Credit note:** use **Create credit note** for a full or part refund of a price. It opens a draft credit note linked to the invoice. Adjust its lines, then issue it like an invoice. It takes GST off in the period it's issued, and the original stays as it was. Credit notes are listed on the invoice.
- **Void:** use **Void invoice** when an invoice was a mistake and nothing has been paid. You must give a reason. Voiding reverses the invoice on the day of the void, so earlier reports don't change.

## Getting paid

See [payments.md](payments.md). When you record a customer receipt against the invoice, its balance owing goes down. On the cash basis, the GST on it also becomes reportable at that point.
