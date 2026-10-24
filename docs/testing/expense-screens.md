# Expense capture and approval screens (#41)

`/expenses` serves two audiences from the #40 API:

- **Office** (`expense.read_all`): every company expense, opening on the
  *Awaiting approval* queue, with a status filter. `/expenses/:id` shows the
  receipt (five-minute private link), the approval snapshot (job cost,
  claimable and non-claimable GST), decide (approve/reject, explicit
  "I checked the receipt") for `expense.approve`, and reversal with an
  optional refund/supplier credit. Accountants read only.
- **Employees** (`expense.submit_own`): their own submissions from
  `/api/my/expenses` (no approval snapshot or cost split), new expenses for
  live-assigned jobs, and edits until decided. `/expenses/:id` is 404.
- Subcontractors: 404.

The GST breakdown is always visible. While typing, it previews with the same
`expenseLine` domain rule the server stores; after saving, it shows the
server's cents. Amounts are parsed to integer cents with `parseAudInput`. A
receipt upload that succeeded is kept if the save fails, so retrying doesn't
upload again.

## Verification

- `tests/e2e/expenses.spec.ts`: live breakdown (incl/ex toggle, GST-free),
  field-error retention, employee edit, employee denial of company reads and
  detail; manager approval with a fixed snapshot ($220.00 job cost without
  verified evidence), accountant read-only, reversal with negated amounts;
  error/retry and empty states, 390/1440px reflow and axe in light and dark.
- The receipt test uses real private storage (CI MinIO, no mocks): upload,
  approver link download byte-for-byte, verified evidence.
- Screenshots: `docs/testing/screenshots/expenses-*.png`.
