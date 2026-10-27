# Ageing, cash movement and accountant exports (#56)

Owners and accountants only. JSON reports need `ledger_report.read`; CSV exports need `export.run`. Every response is
`private, no-store`. Money is **AUD integer cents**; each column name states its basis (`_inclusive_cents`,
`_exclusive_cents` or a GST label).

## Reports (JSON)

- `GET /api/reports/ageing?side=receivables|payables&asAt=YYYY-MM-DD&page=1&pageSize=100` (page size 1–1000).
  - **What is owed as at a day.** It is computed as the records stood at the end of the as-at day: issued invoices less receipts, refunds and credit notes; or supplier bills less payments and supplier credits.
  - **Dating:** each settlement, credit or void counts from its own business day (Australia/Sydney). A later void never changes an earlier ageing.
  - **Buckets** are days past the due date, or past the issue date when there is no due date: `current`, `days1To30`, `days31To60`, `days61To90`, `days91Plus`.
  - **Totals:** `totals` and `parties` always cover every row. `rowsPage` pages the rows only.
  - **What's read:** the database first narrows to documents with something owed on that day, using the same rule, so settled history isn't read.
  - **Payables** are supplier bills. A contractor's bills age under the contractor; other bills age under the supplier name.
- `GET /api/reports/cash?from=&to=` gives receipts less payments by month: `moneyIn`, `moneyOut` and `net`.
  - **Not profit.** The report carries the label "Cash movement — money in less money out, not profit".
  - **Source:** it comes from the same bounded event source as profitability (#157), so it always equals profitability's `receivedInclusive − paidInclusive`.
  - **Signs:** a refund is negative money in. A voided settlement is reversed on its void day.

## CSV exports

`GET /api/exports/<name>?…`:
- **Format:** RFC 4180, UTF-8, CRLF line ends, with a header row. Text cells are always quoted.
- **Money cells** are bare signed ASCII integers (`-1500`): never a currency symbol, digit grouping, GST label or typographic minus. An empty cell means no value.
- **Formula-safe text:** a text cell that starts with `=`, `+`, `-` or `@` (after leading whitespace or control characters), or with a control character, is prefixed with `'` so spreadsheets don't run it as a formula (#70).
- **One snapshot:** each export reads one repeatable-read snapshot, records a `report.exported` audit event, then streams.
- **Refused requests:** an invalid request returns 400 and reads and records nothing.
- **Throttle:** 5 exports a minute per user **and** per IP (`throttle(db, "export", …)`). Over the limit returns 429 before anything is read.
- **Incomplete GST is never exported.** If cash-basis GST is left out of the draft because records need review (the screen's "incomplete" warning), both GST exports return 409 with the warnings, and the refusal is audited as `report.export_refused`. Resolve the records first. A finalised period was complete when it was locked.

| Export | Query | Columns |
|---|---|---|
| `gst-summary` | `from`, `to` | `from`, `to`, `status` (`draft`/`finalised`), `revision`, `g1_total_sales_inclusive_cents`, `label_1a_gst_on_sales_cents`, `label_1b_gst_on_purchases_cents`, `net_gst_cents`, `label` |
| `gst-lines` | `from`, `to` | `date`, `event_id`, `bas_label` (`1A`/`1B`), `source_type`, `source_id`, `source_reference`, `party_name`, `job_id`, `gst_cents`, `g1_sales_inclusive_cents`, `period_status` |
| `profitability` | `from`, `to`, optional `jobId` (this company's job, otherwise 404) | `from`, `to`, `row_type` (`job`/`unallocated`/`total`), `job_id`, `job_reference`, `job_title`, `revenue_exclusive_cents`, `job_cost_exclusive_cents`, `gross_profit_cents`, `margin_basis_points`, `received_inclusive_cents`, `paid_inclusive_cents` |
| `ageing` | `side`, `asAt` | `as_at`, `side`, `document_id`, `reference`, `party_type`, `party_name`, `issued_on`, `due_on`, `days_overdue`, `bucket`, `document_inclusive_cents`, `owed_inclusive_cents` |
| `cash` | `from`, `to` | `month` (`YYYY-MM`), `money_in_inclusive_cents`, `money_out_inclusive_cents`, `net_cash_cents` |

**GST exports in a finalised period:** when the range is exactly a finalised GST period, both GST exports come from its latest locked revision (`status` `finalised`, with its `revision`), exactly as the report shows it.

**GST lines:**
- `gst_cents` of `1A` lines sums to label 1A, and `1B` lines to 1B.
- Credit notes, voids and corrections appear as their own signed lines on their own dates.
- `source_type` is one of `invoice`, `credit_note`, `supplier_bill`, `supplier_credit`, `expense`, `gst_adjustment`, `customer_receipt`, `customer_refund` or `supplier_payment`. On the cash basis, GST lines come from the receipts and payments that settled each document.

**Draft only:** this is a draft for the accountant; JobFlow does not lodge anything.
