# Timesheet entry and approval screens (#39)

`/timesheets` uses the #38 API:

- **Employees** (`timesheet.submit_own`): *My time* — log hours and minutes on
  a live-assigned job (optionally one of its non-cancelled visits) for today or
  earlier, and edit until decided. Entries come from `/api/my/timesheets`,
  which has no rate, cost or other employees' rows.
- **Approvers** (`timesheet.approve`: owner, manager): the queue opens on
  *Awaiting approval* with a status filter, and each row has approve or reject
  with a note. Approved rows can be reversed with a reason (negated hours and
  cost; the original is kept). Rate and labour cost show only with
  `employee.cost_rate.read`, as fixed on approval.
- Accountants and subcontractors: 404.

Approval with no cost rate on the work date is refused by the server
("Set …'s cost rate …") and the message is shown on the row. There's no
rate-entry screen yet; see the follow-up issue.

## Verification

`tests/e2e/timesheets.spec.ts`: employee entry with a live total, an invalid
duration that keeps the other entries, edits, and no rate or cost in the
payload or on screen, and denial of the office list and rate history; the
manager queue refuses approval without a rate, then approves with a fixed
labour cost and reverses (−7h 30m row); error, retry and empty states,
390/1440px reflow and axe in light and dark, and accountant/subcontractor 404.
Screenshots: `docs/testing/screenshots/timesheets-*.png`.
