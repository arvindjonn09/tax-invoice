# Dashboard verification (#57)

- Shared database fixtures: registered accruals, registered cash and not registered; dashboard profit/GST equal report totals, before/after the receipt and supplier payment. Profit remains 105000 cents (42%); customer and supplier balances reconcile.
- Customer/job filters affect activity, GST and as-at balances. Cross-company object IDs return 404, invalid dates return 400, unauthenticated API access returns 401, workers get 403, managers receive no GST/ledger data.
- Browser tests: owner opens an overdue invoice directly, filters by customer/job, sees Demo Data; manager/worker isolation; retry and empty states; reversed dates disable submission. Axe and no horizontal scroll at 360, 390, 768, 1024 and 1440 pixels in both themes.
- Screenshots: [desktop light](screenshots/dashboard-light-1440.png), [desktop dark](screenshots/dashboard-dark-1440.png), [mobile light](screenshots/dashboard-light-390.png), [mobile dark](screenshots/dashboard-dark-390.png). All records are synthetic.

The separate #59 end-to-end acceptance workflow and #60 whole-application accessibility audit remain open. This verification covers this dashboard only.
