# Job screens (#33)

`/jobs` provides bounded server search, status filters, allowlisted sorting and
pagination. Office users see company jobs; employees use their assigned-job API.
Both table and mobile-card layouts use the approved shell and semantic themes.
Owners/managers create and edit; accountants read. Subcontractor job details remain
in the separate portal scope (#37), with an explicit placeholder until available.

The detail route validates the actor, company and assigned object before rendering.
Tabs cover overview, assignments, visits, files (explicit future-release placeholder)
and the office status timeline. Employees receive only their safe work/visit projection;
there are no price, cost, assignments or internal timeline fields in their response.

Forms keep errors and inputs, warn before leaving or switching sections, and disable
controls during writes. Decimal AUD entry becomes integer-cent strings using BigInt;
display reuses MoneyDisplay. There is no GST, invoice, expense or profit calculation in
these screens. Unchanged visit times retain their original seconds/milliseconds, and
multiline visit notes remain intact. Times are displayed in the browser's timezone.

The shared request hook retains last-loaded data on transient refresh failures, with
an explicit alert and retry. It clears that data on 401/403/404 responses and on URL
changes. Customer screens reuse the extracted hook and navigation guard; their public
import paths are retained. Job tab changes confirm before discarding unsaved forms.

Office assignment rows identify inactive employees. Cancelled visits cannot receive
new assignments, and the shared office assignment projection is a leaf module, avoiding
the earlier handlers/assignments import cycle. Actor display names accompany office
status events; employee projections do not include that internal timeline.

Verification:

- `tests/unit/aud-input.test.ts`: exact decimal/cent boundaries and invalid amounts.
- Jobs/assignments integration tests: scoped search, sort fallback, paging, actor/object
  restrictions, inactive assignee state and cancelled-visit refusal without audit changes.
- `tests/e2e/jobs.spec.ts`: create → visit → assign → status change → unassign; visit
  precision/notes; employee visit/price isolation; accountant read-only; failed saves,
  section guards, transient retry and denied-data clearing; keyboard tabs, axe checks,
  390px/1440px captures in light/dark and long-title overflow checks.
- Run the existing customer browser suite too, because its shared hooks were extracted.

No third-party components or dependencies were added. Existing audited Button,
FormField, PageHeader, MoneyDisplay and original native controls are reused.
