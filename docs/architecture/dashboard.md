# Live dashboard (#57)

`GET /api/dashboard?from=&to=&customerId=&jobId=` requires `job.profit.read`. The page returns 404 for workers; the API returns 401/403. Every object filter is validated and scoped to the actor's company.

A single RepeatableRead transaction uses the existing bounded financial event projection and domain `profitabilityReport`, `draftGstReport` and `ageingReport` calculations. No financial arithmetic occurs in the browser. A company-wide exact finalised range uses the locked GST revision. Incomplete cash GST retains its warning. Recoverable GST never enters profit; costs include non-creditable GST.

Activity totals use the inclusive date range. Outstanding/overdue balances include older unsettled documents as at the earlier of the range end and today in Sydney; customer and job filters apply to both balances and activity. Payables are supplier bills, matching the ageing report (not unpaid expenses). Only the ten oldest overdue invoice links and eight recently updated jobs are displayed; totals cover all matching records. Recent job status is current, independent of activity dates.

GST and company-wide receivable/payable balances require their existing `gst_report.read` and `ledger_report.read` permissions. Managers get profit/cash activity only. Customer/job selectors retain an independent options list while requests load. Private/no-store responses and the existing persistent company Demo Data indicator apply.

Validation: shared registered/non-cash, registered/cash and unregistered fixtures reconcile dashboard = reporting = expected balances before/after settlements. Browser coverage checks all five widths 360–1440 in both themes, axe, role denial, filters, retry/empty states and a direct overdue-invoice link. Production deployment and accountant sign-off remain separate checkpoints.
