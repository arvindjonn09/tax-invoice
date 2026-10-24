# Contractor directory and offer management (#36)

Office roles use `/contractors` to search by name, email or ABN, filter active/archived
records and page through name-ordered results. Owners and managers create/edit contact
and GST details, archive/restore with confirmation, and manage offers. Accountants
read without write controls. Employee and subcontractor pages return 404; APIs enforce
their own permissions and tenant scope. The subcontractor portal remains #37.

Detail routes check role, company and object existence before rendering. All client
reads/writes go through protected APIs. A contractor's detail includes the server's
offer history. The job picker searches and pages company jobs; offered terms can be
edited or withdrawn, while accepted terms are read-only and display their immutable
acceptance snapshot and committed cost. Commitment is labelled separately from
incurred cost and payment; supplier bills are a later module.

AUD input reuses the BigInt decimal-to-cent parser. GST and offer totals are calculated
by the server/domain and displayed as returned, including separate exclusive, GST and
inclusive amounts. The screens do not implement GST/profit arithmetic. Hourly offers
accept decimal estimated hours; unregistered contractors cannot select taxable GST.

Forms retain failed edits, show server field errors and warn before navigation or
cancellation. Writes disable controls. Loading, empty, retry and saved states are
explicit. Transient refresh errors retain prior data with a warning; denied responses
clear it through the shared request hook. Directory cards wrap long data and adapt
across mobile/desktop; existing semantic light/dark themes and audited components are
reused, with no added dependency or migration.

`tests/e2e/contractors.spec.ts` covers manager create/edit, fixed/hourly offer creation/edit/withdrawal, invalid decimal handling, acceptance
through the linked subcontractor API, immutable totals after GST master-data change,
failed-save retention/navigation guards, archive confirmation/restore, search/empty/retry,
accountant read-only, employee/subcontractor denial, axe checks and 390px/1440px screenshots
in both themes. API authorisation/tenancy/concurrency tests remain in
`tests/integration/contractors.test.ts`.
