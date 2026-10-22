# Dashboard screen specification

Issue #22 · owner review pending. Uses the [design system](../design-system.md), [financial definitions](../../DATA_MODEL.md) and [UI brief](../../UI_DESIGN.md). This specifies the M0 design preview and the later M4 production screen; it implements neither. See the [owner review sheet](../review-22.md).

## Purpose and access

The owner can see invoiced profit, outstanding balances and the next operational task without confusing profit with cash. The manager receives authorised operational and job-profit sections; the accountant receives authorised financial/reporting sections. Server policy decides each section and drill-down. Employee and subcontractor dashboards show only their assignments/offers and never receive customer prices, profits or other workers' rates. Do not fetch a full owner payload then hide fields.

In M0 use `/design-preview/dashboard` (or an explicitly named preview route selected in #23), with the persistent “Design preview — not real data” banner. Every amount below is an immutable labelled sample. No data queries, financial computations, writes, drill-down to fake business records or simulated success. Real `/dashboard` and linked business routes arrive with M4 dependencies. Navigation between preview specimens may work.

## Desktop layout and content

```text
┌──────────────┬───────────────────────────────────────────────────────┐
│ JobFlow      │ Demo Data [only if server confirms demo records]      │
│ Dashboard    │ Design preview — not real data [M0 only]              │
│ Jobs         ├───────────────────────────────────────────────────────┤
│ Customers    │ Dashboard                                             │
│ …            │ AUD · 1–31 Oct 2026 · Australia/Sydney                 │
│              │ Period [This month ▾]  Updated [time / sample label]   │
│              ├────────────────────┬─────────────────┬────────────────┤
│              │ Invoiced revenue   │ Incurred cost   │ Gross profit   │
│              │ ex GST $2,500.00   │ $1,450.00 *     │ $1,050.00      │
│              │                    │                 │ Margin 42%     │
│              ├────────────────────┼─────────────────┼────────────────┤
│              │ Received incl GST  │ Paid incl GST   │ Net cash       │
│              │ $1,000.00          │ $400.00         │ $600.00        │
│              ├────────────────────┴─────────────────┴────────────────┤
│              │ Customer outstanding       Supplier outstanding      │
│              │ $1,750.00 incl GST         $590.00 incl GST           │
│              │ Overdue invoices: 1 →      View supplier balances →  │
│              ├──────────────────────────────┬────────────────────────┤
│              │ Recent jobs                  │ Draft BAS/GST summary  │
│              │ Job / customer / state / date│ not lodged             │
│              │ Job detail links             │ G1 / 1A / 1B / net     │
│              │ View all jobs →              │ View draft details →   │
└──────────────┴──────────────────────────────┴────────────────────────┘
* Incurred cost: ex GST + non-creditable GST. Profit: invoiced basis.
```

All fixture names are synthetic, e.g. “Sample Customer A” and “Sample Job 001”; no ABNs, addresses or bank details. Static preview date text says “Sample period” and “Sample values”; do not imply the data was refreshed. Dollar values above are the registered combined fixture from [GST.md](../../GST.md#combined-gst-and-profit-acceptance-fixture). Received and paid are independent cash events, never added to incurred cost. Net cash is receipts less payments and labelled “Cash movement, not profit”. In production these sections have distinct periods: activity metrics for the selected period; outstanding balances “As at [end date]”; overdue uses the same date and excludes settled/void balances.

Component composition: AppShell → PageHeader → FilterBar/DateRangePicker → KPIStat groups → DataTable recent jobs → draft summary. Heading sequence: Dashboard h1; Profit and costs, Cash movement, Outstanding balances, Recent jobs, Draft BAS/GST summary h2. Each metric has a basis and period. Do not show an unlabeled aggregate “Revenue”. Gross margin uses invoiced revenue; zero revenue shows N/A.

Revenue and incurred costs are actual approved/issued amounts. A separate optional “Projected (accepted quote basis)” group may show estimates when authorised; never replace actuals or blend them. “Quoted”, “Committed”, “Incurred” and “Paid” remain separate terms. No projected fixture values are invented for M0.

Draft summary shows “Draft BAS/GST summary, not lodged”, period and cash/non-cash basis. In the registered non-cash fixture: G1 total sales $2,750.00 incl GST, 1A GST on sales $250.00, 1B GST credits $105.00, indicative net GST payable $145.00. Label this an ordinary-supply sample, not universal BAS treatment. If unregistered show “Not GST registered for this period” and no fabricated GST liability. Registration changes within the period require a period-specific explanation from the server. The real report's G1 inclusions, attribution and rounding follow accountant-approved rules.

## Overdue invoice path: two clicks

Production click 1: the text link “Overdue invoices: 1” opens `/invoices?status=overdue` retaining the dashboard as-at context in a supported filter. The list announces “Overdue invoices” and displays invoice number, customer, due date, days overdue and outstanding incl GST. Click 2: the invoice number opens authorised invoice detail. Sorting, pagination and permissions are server scoped. A fresh session must repeat auth checks on the target. If a balance was settled meanwhile, show its current status and an explanatory message instead of stale overdue data. In M0 document this path beside the disabled sample link; do not fabricate a working invoice list before M3.

## States

| State | Visual/content behaviour | Focus and recovery |
|---|---|---|
| Loading | Real M4: skeletal labels/cards with “Loading dashboard”; do not briefly show zeros. Banner remains visible. M0: a separately labelled static specimen. | Main region `aria-busy`; one polite completion announcement. No focus move during refresh. |
| Empty | “No activity in this period.” Show genuine zero totals only when returned as zero. Recent jobs: “No jobs yet.” | Authorised “Create job” exists only once its module is functional; otherwise explanatory text. No fake data. |
| Filtered empty | “No activity matches these dates.” Keep selected dates and distinguish from first use. | Clear dates/reset to This month. |
| Error | “Dashboard could not be loaded. Try again.” A failing section can show its own ErrorState while independent sections remain usable; do not sum partial data as complete totals. | Retry failed request, preserve filters; safe request reference only. Missing demo status blocks business content per shell rule. |
| Success | Real complete values with “Updated [date/time Australia/Sydney]”, basis and period. No success toast for merely visiting. | Preserve focus; link labels identify destinations. |
| Stale | “Showing data updated [time]. Refresh failed.” Explicitly distinguish cached values from current figures. | Retry; stale data never supports a financial mutation. |
| Unavailable | Metric says “Unavailable” and reason where safe, never $0.00. No comparison against missing baseline. | Safe recovery or contact-admin text. |
| Access denied/session expired | No financial data; follow shared login/access denied screen. | Return to requested authorised destination after login; no private state in URL. |

## Responsive and keyboard behaviour

360/390px: mobile menu, single-column KPI cards grouped under headings, date controls stacked, outstanding cards before recent jobs; recent-job cards preserve job number, customer, status and date. No clipped figures. 768px: two KPI columns and stacked lower sections. 1024/1440px: three KPI columns, sidebar, lower 2:1 split. At 400% zoom use the mobile arrangement; permit long labels to wrap. Cards are not whole-card links with nested buttons; use named text links.

Tab order follows displayed reading order: skip link, navigation, period controls, outstanding links, recent-job links, report link. Date control has a typed-date alternative, explicit Apply and range errors. Status pills include icon plus written status; all money uses tabular figures. Use design-system light/dark pairs and visible focus; sticky headers cannot hide focused links. Reduced motion removes shimmer and transitions.

## Verification handoff

#23 must render labelled static specimens of loading/empty/error/success for owner comparison, plus registered and unregistered financial labels; no data logic. M4 #57 implements production states and permissions. QA verifies 360, 390, 768, 1024 and 1440px in both themes, keyboard, screen reader, 200% text and 400% zoom. M3/M4 E2E proves the two-click overdue route, updated/settled invoice behaviour and employee/subcontractor data absence. Owner review is still pending in the review sheet.
