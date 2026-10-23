# Employee assignments (#32)

Owners and managers use `POST /api/jobs/:id/assignments` with `employeeId` and
optional `visitId`; `PATCH /api/jobs/:id/assignments/:assignmentId` with
`{ "ended": true }` ends an assignment while retaining its history. Office job
details include the assignment list. Accountants and workers cannot mutate it.

Assignments are scoped to the company, job, employee and optional visit using
composite foreign keys. Partial unique indexes prevent duplicate live whole-job
or visit assignments. Creation locks the job before checking its current status,
then locks and rechecks the employee's active state. Ending also locks the job,
so concurrent requests cannot both end/audit the same assignment. Ended records
remain, and reassigning creates a new row. Ending is permitted to revoke access
on terminal jobs; creating assignments on terminal jobs is refused.

`GET /api/my/jobs` and `/api/my/jobs/:id` resolve active employee records linked
to the signed-in user and live assignments. Another tenant's job, an unassigned
job or an invalid ID returns 404. The explicit response projections exclude
customer prices, cost rates, costs, profit and internal visit notes. A whole-job
assignment grants its visits; a visit-only assignment grants only that visit.
Employee deactivation or ending all relevant assignments removes access.

The migration retains the reserved `20261023070000_assignments` timestamp after
jobs `060000`; later invitation/document/customer-primary migrations remain intact.
The rollback removes assignments before the jobs/employee tables are rolled back.
Integration tests cover roles, tenants, response shapes, active employee eligibility,
visit scope, duplicate assignments, terminal jobs, deactivation and concurrent ends.
Screens are delivered separately in #33. No timesheets, rates or payroll are added.
