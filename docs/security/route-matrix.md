# API route permission matrix (#61)

Generated from the route files and `packages/authz/src/policy.ts` by `pnpm exec tsx tests/helpers/route-matrix.ts --write`. `tests/unit/route-matrix.test.ts` fails if this file is out of date. Every route is deny-by-default (`withPolicy`); each handler also checks company and object scope.

| Route | Method | Permission | Roles |
|---|---|---|---|
| `/api/auth/[...all]` | GET | — | public (see route-policy.test.ts) |
| `/api/auth/[...all]` | POST | — | public (see route-policy.test.ts) |
| `/api/bill-submissions` | GET | `bill.read` | owner, manager, accountant |
| `/api/bill-submissions/[id]` | GET | `bill.read` | owner, manager, accountant |
| `/api/bill-submissions/[id]/approve` | POST | `bill.write` | owner, accountant |
| `/api/bill-submissions/[id]/reject` | POST | `bill.write` | owner, accountant |
| `/api/bills` | GET | `bill.read` | owner, manager, accountant |
| `/api/bills` | POST | `bill.write` | owner, accountant |
| `/api/bills/[id]` | GET | `bill.read` | owner, manager, accountant |
| `/api/bills/[id]/credits` | POST | `bill.write` | owner, accountant |
| `/api/bills/[id]/evidence` | POST | `bill.write` | owner, accountant |
| `/api/bills/[id]/void` | POST | `bill.write` | owner, accountant |
| `/api/company` | GET | `company.read` | owner, manager, accountant, employee, subcontractor |
| `/api/company` | PATCH | `company.update` | owner |
| `/api/company/export` | GET | `export.run` | owner, accountant |
| `/api/company/gst` | GET | `gst_settings.read` | owner, accountant |
| `/api/company/gst` | PATCH | `gst_settings.update` | owner, accountant |
| `/api/company/gst/registrations` | POST | `gst_settings.update` | owner, accountant |
| `/api/company/gst/registrations/[id]` | PATCH | `gst_settings.update` | owner, accountant |
| `/api/company/trial` | GET | `company.read` | owner, manager, accountant, employee, subcontractor |
| `/api/contractors` | GET | `contractor.read` | owner, manager, accountant |
| `/api/contractors` | POST | `contractor.write` | owner, manager |
| `/api/contractors/[id]` | GET | `contractor.read` | owner, manager, accountant |
| `/api/contractors/[id]` | PATCH | `contractor.write` | owner, manager |
| `/api/customers` | GET | `customer.read` | owner, manager, accountant |
| `/api/customers` | POST | `customer.write` | owner, manager |
| `/api/customers/[id]` | GET | `customer.read` | owner, manager, accountant |
| `/api/customers/[id]` | PATCH | `customer.write` | owner, manager |
| `/api/customers/[id]/contacts` | POST | `customer.write` | owner, manager |
| `/api/customers/[id]/contacts/[childId]` | PATCH | `customer.write` | owner, manager |
| `/api/customers/[id]/locations` | POST | `customer.write` | owner, manager |
| `/api/customers/[id]/locations/[childId]` | PATCH | `customer.write` | owner, manager |
| `/api/dashboard` | GET | `job.profit.read` | owner, manager, accountant |
| `/api/documents` | POST | `document.upload` | owner, manager, accountant, employee, subcontractor |
| `/api/documents/[id]/link` | POST | `document.upload` | owner, manager, accountant, employee, subcontractor |
| `/api/employees` | GET | `employee.read` | owner, manager, accountant |
| `/api/employees` | POST | `employee.write` | owner, manager |
| `/api/employees/[id]` | GET | `employee.read` | owner, manager, accountant |
| `/api/employees/[id]` | PATCH | `employee.write` | owner, manager |
| `/api/employees/[id]/rates` | GET | `employee.cost_rate.read` | owner, manager |
| `/api/employees/[id]/rates` | POST | `employee.write` | owner, manager |
| `/api/employees/linkable-users` | GET | `employee.write` | owner, manager |
| `/api/expenses` | GET | `expense.read_all` | owner, manager, accountant |
| `/api/expenses` | POST | `expense.submit_own` | owner, manager, employee |
| `/api/expenses/[id]` | GET | `expense.read_all` | owner, manager, accountant |
| `/api/expenses/[id]` | PATCH | `expense.submit_own` | owner, manager, employee |
| `/api/expenses/[id]/decision` | POST | `expense.approve` | owner, manager |
| `/api/expenses/[id]/reversal` | POST | `expense.approve` | owner, manager |
| `/api/exports/[name]` | GET | `export.run` | owner, accountant |
| `/api/files/[token]` | GET | — | public (see route-policy.test.ts) |
| `/api/health` | GET | — | public (see route-policy.test.ts) |
| `/api/health/ready` | GET | — | public (see route-policy.test.ts) |
| `/api/invitations/accept` | POST | — | public (see route-policy.test.ts) |
| `/api/invoices` | GET | `invoice.read` | owner, manager, accountant |
| `/api/invoices` | POST | `invoice.write` | owner, accountant |
| `/api/invoices/[id]` | DELETE | `invoice.write` | owner, accountant |
| `/api/invoices/[id]` | GET | `invoice.read` | owner, manager, accountant |
| `/api/invoices/[id]` | PATCH | `invoice.write` | owner, accountant |
| `/api/invoices/[id]/credit-notes` | POST | `invoice.issue` | owner, accountant |
| `/api/invoices/[id]/issue` | POST | `invoice.issue` | owner, accountant |
| `/api/invoices/[id]/pdf` | POST | `invoice.read` | owner, manager, accountant |
| `/api/invoices/[id]/void` | POST | `invoice.issue` | owner, accountant |
| `/api/jobs` | GET | `job.read_all` | owner, manager, accountant |
| `/api/jobs` | POST | `job.write` | owner, manager |
| `/api/jobs/[id]` | GET | `job.read_all` | owner, manager, accountant |
| `/api/jobs/[id]` | PATCH | `job.write` | owner, manager |
| `/api/jobs/[id]/assignments` | POST | `job.assign` | owner, manager |
| `/api/jobs/[id]/assignments/[assignmentId]` | PATCH | `job.assign` | owner, manager |
| `/api/jobs/[id]/evidence` | GET | `job.read_all` | owner, manager, accountant |
| `/api/jobs/[id]/offers` | GET | `contractor.read` | owner, manager, accountant |
| `/api/jobs/[id]/offers` | POST | `contractor.write` | owner, manager |
| `/api/jobs/[id]/offers/[offerId]` | PATCH | `contractor.write` | owner, manager |
| `/api/jobs/[id]/review` | POST | `job.write` | owner, manager |
| `/api/jobs/[id]/status` | POST | `job.write` | owner, manager |
| `/api/jobs/[id]/visits` | POST | `job.write` | owner, manager |
| `/api/jobs/[id]/visits/[visitId]` | PATCH | `job.write` | owner, manager |
| `/api/my/bills` | GET | `bill.submit_own` | owner, subcontractor |
| `/api/my/bills` | POST | `bill.submit_own` | owner, subcontractor |
| `/api/my/expenses` | GET | `expense.submit_own` | owner, manager, employee |
| `/api/my/jobs` | GET | `job.read_assigned` | owner, employee, subcontractor |
| `/api/my/jobs/[id]` | GET | `job.read_assigned` | owner, employee, subcontractor |
| `/api/my/offers` | GET | `offer.read_own` | owner, subcontractor |
| `/api/my/offers/[id]` | GET | `offer.read_own` | owner, subcontractor |
| `/api/my/offers/[id]` | POST | `offer.respond_own` | owner, subcontractor |
| `/api/my/timesheets` | GET | `timesheet.submit_own` | owner, employee |
| `/api/my/work/[id]/evidence` | GET | `evidence.submit_assigned` | owner, employee, subcontractor |
| `/api/my/work/[id]/evidence` | POST | `evidence.submit_assigned` | owner, employee, subcontractor |
| `/api/my/work/[id]/submit` | POST | `evidence.submit_assigned` | owner, employee, subcontractor |
| `/api/quotes` | GET | `quote.read` | owner, manager, accountant |
| `/api/quotes` | POST | `quote.write` | owner, manager |
| `/api/quotes/[id]` | DELETE | `quote.write` | owner, manager |
| `/api/quotes/[id]` | GET | `quote.read` | owner, manager, accountant |
| `/api/quotes/[id]` | PATCH | `quote.write` | owner, manager |
| `/api/quotes/[id]/accept` | POST | `quote.write` | owner, manager |
| `/api/quotes/[id]/decline` | POST | `quote.write` | owner, manager |
| `/api/quotes/[id]/revise` | POST | `quote.write` | owner, manager |
| `/api/quotes/[id]/send` | POST | `quote.write` | owner, manager |
| `/api/receipts` | GET | `payment.read` | owner, manager, accountant |
| `/api/receipts` | POST | `payment.write` | owner, accountant |
| `/api/receipts/[id]` | GET | `payment.read` | owner, manager, accountant |
| `/api/receipts/[id]/void` | POST | `payment.write` | owner, accountant |
| `/api/reports/ageing` | GET | `ledger_report.read` | owner, accountant |
| `/api/reports/cash` | GET | `ledger_report.read` | owner, accountant |
| `/api/reports/gst` | GET | `gst_report.read` | owner, accountant |
| `/api/reports/gst/adjustments` | POST | `gst_settings.update` | owner, accountant |
| `/api/reports/gst/periods` | GET | `gst_report.read` | owner, accountant |
| `/api/reports/gst/periods` | POST | `gst_settings.update` | owner, accountant |
| `/api/reports/gst/periods/[id]/amend` | POST | `gst_settings.update` | owner, accountant |
| `/api/reports/profitability` | GET | `job.profit.read` | owner, manager, accountant |
| `/api/supplier-credits/[id]` | GET | `bill.read` | owner, manager, accountant |
| `/api/supplier-credits/[id]/void` | POST | `bill.write` | owner, accountant |
| `/api/supplier-payments` | GET | `payment.read` | owner, manager, accountant |
| `/api/supplier-payments` | POST | `payment.write` | owner, accountant |
| `/api/supplier-payments/[id]` | GET | `payment.read` | owner, manager, accountant |
| `/api/supplier-payments/[id]/void` | POST | `payment.write` | owner, accountant |
| `/api/timesheets` | GET | `timesheet.approve` | owner, manager |
| `/api/timesheets` | POST | `timesheet.submit_own` | owner, employee |
| `/api/timesheets/[id]` | PATCH | `timesheet.submit_own` | owner, employee |
| `/api/timesheets/[id]/decision` | POST | `timesheet.approve` | owner, manager |
| `/api/timesheets/[id]/reversal` | POST | `timesheet.approve` | owner, manager |
| `/api/users` | GET | `user.manage` | owner |
| `/api/users/[id]` | PATCH | `user.manage` | owner |
| `/api/users/invitations` | POST | `user.manage` | owner |
| `/api/users/invitations/[id]` | DELETE | `user.manage` | owner |
