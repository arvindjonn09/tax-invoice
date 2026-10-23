# Customer directory screens (#29)

`/customers` supports explicit search (name, email, ABN or suburb), active/archived/all status,
stable allowlisted sorting and bounded pagination. At narrow widths, cards replace the table.
`/customers/[id]` provides billing details, contacts, primary contact selection and job sites.
Archive and restore preserve existing records; job and invoice history remains a labelled placeholder.

Owners and managers can create and edit; accountants can read. Worker roles cannot open either page.
The detail route checks the company-scoped customer before rendering; existing API policies recheck
company/object permissions on every read and write. Form errors preserve inputs, inline errors are
associated with fields, and unsaved edits warn before leaving or cancelling, including
same-document Back/Forward traversal. The Navigation API cancels supported traversals
before unmount; older browsers restore the current history entry on refusal (which
can replace forward history). The 500-character site access-notes limit matches the API. Demo indication comes
from the database-backed application shell.

Verification uses synthetic isolated databases:

- `pnpm test` and `pnpm test:integration`: existing customer tenant, contact, location and archive tests,
  plus stable sorting, invalid-sort fallback and isolation coverage.
- `pnpm test:e2e tests/e2e/customers.spec.ts --workers=1`: customer/contact/site creation, updates,
  archive/restore, validation and failed-save retention, search, retry, read-only accountant and denied workers.
- Browser axe checks and screenshots at 390px/1440px in both themes; production build, strict
  type-check, lint and formatting complete the application checks. CI supplies security gates.

Invitation and employee management remain separate modules. Contact/site lists include archived
records with explicit status and restore actions; customer searches default to active records.
