[![Quality and security checks](https://github.com/arvindjonn09/tax-invoice/actions/workflows/scaffold.yml/badge.svg?branch=main)](https://github.com/arvindjonn09/tax-invoice/actions/workflows/scaffold.yml)

# tax-invoice (JobFlow)
Build Plan: Custom Job Management & Accounting Application

> **Source of truth.** This README is the original build plan. The detailed, current specification lives in
> [`docs/`](docs/) — [REQUIREMENTS](docs/REQUIREMENTS.md), [GST](docs/GST.md), [DATA_MODEL](docs/DATA_MODEL.md),
> [ARCHITECTURE](docs/ARCHITECTURE.md), [SECURITY](docs/SECURITY.md), [UI_DESIGN](docs/UI_DESIGN.md) and the
> [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md). AI agents follow [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md).
> Work is tracked in [GitHub Issues](https://github.com/arvindjonn09/tax-invoice/issues) under milestones M0–M5.

We will build a web application similar to the core job-tracking features of MYOB Business Pro, but tailored to your contracting business.

The application will track every dollar received, spent, owed and earned on each job, whether the work is completed by your employees or an external subcontractor.

**Scope (updated 2026-10-22):**

- **Included in v1:** Australian GST calculation (taxable, GST-free, input-taxed and out-of-scope lines), compliant tax invoices, creditable GST on supplier bills and expenses, and **draft** GST/BAS summaries (G1, 1A, 1B) with accountant export. See [docs/GST.md](docs/GST.md).
- **Excluded:** BAS lodgement with the ATO, superannuation calculation, PAYG withholding, STP payroll reporting, payroll processing, and bank-payment initiation.

Important: GST/BAS output is a draft for review by your accountant or registered tax agent before lodgement. Excluding payroll and superannuation features from the application does not remove any superannuation, payroll or recordkeeping obligations your Australian business may have.

1. Application modules

Module	Main functions
Dashboard	Revenue, expenses, gross profit, payments outstanding, active jobs
Customers	Companies, contacts, locations, billing details
Jobs	Work orders, deadlines, status, internal notes, agreed prices
Quotes	Customer quotes, approval, conversion to jobs
Employees	Employee records, job assignments, hours, labour cost
Subcontractors	Contractor directory, quotes, assignments, agreed rates, invoices
Expenses	Materials, parking, transport, purchases, other job costs
Invoices	Numbered customer invoices, PDFs, due dates, partial payments
Payments	Customer receipts, supplier payments, outstanding balances
Profitability	Profit by job, customer, technician, month and year
Documents	Work orders, receipts, photos, customer signatures
Reports	Revenue, cash flow, job profitability, receivables and payables
Administration	Users, permissions, settings, activity logs and backups

2. Business workflow

1. Receive customer job

Create work order and customer quote

2. Choose who completes the work

Employee or external subcontractor

Employee

Hours × internal cost rate

Subcontractor

Quoted and approved fee

3. Complete and approve the job

Timesheets, photos, expenses, customer sign-off

4. Invoice the customer

Record full or partial customer payments

5. Record supplier payments

Track committed, invoiced and paid costs separately

6. Calculate job profit and cash position

Estimated vs actual costs, margin, outstanding money

3. Application architecture

I recommend a modular monolith, not microservices. This means one maintainable application with well-separated features.

Layer	Technology
Frontend	Next.js, React, TypeScript
Styling	Tailwind CSS and shadcn/ui
Backend	Node.js with Next.js server APIs or a separately organised service layer
Database	PostgreSQL
ORM	Prisma
Authentication	Auth.js or an equivalent established solution
File storage	S3-compatible storage
Background tasks	Redis-backed job queue when required
PDF invoices	Server-side PDF generation
Hosting	Docker on Ubuntu with HTTPS
Testing	Vitest, Playwright and database integration tests

Suggested project structure:

jobflow/
├── apps/
│   └── web/
│       ├── src/app/
│       ├── src/components/
│       └── src/features/
│           ├── dashboard/
│           ├── customers/
│           ├── jobs/
│           ├── contractors/
│           ├── employees/
│           ├── quotes/
│           ├── invoices/
│           ├── expenses/
│           ├── payments/
│           └── reports/
├── packages/
│   ├── database/
│   ├── business-logic/
│   ├── permissions/
│   └── shared-types/
├── infra/
│   ├── docker/
│   └── nginx/
├── tests/
├── docs/
└── README.md

The next important design decision is the financial data model. A simple jobs table with a profit column will not be reliable enough. Costs and payments must be recorded as separate transactions with an audit history.

4. Database and financial calculation rules

We need these primary database entities:

companies
users
roles
customers
customer_contacts
jobs
job_assignments
employees
subcontractors
subcontractor_offers
timesheets
job_costs
quotes
quote_items
invoices
invoice_items
customer_payments
supplier_bills
supplier_payments
documents
audit_logs
settings

Every financial record must have a unique ID, company ID, currency, timestamp, creator and appropriate approval status. Use database transactions and foreign keys to prevent orphaned records.

Profit calculation

Assume a job has (all amounts **GST-exclusive**; see the GST-registered variant in [docs/GST.md](docs/GST.md#combined-gst-and-profit-acceptance-fixture)):

Description	Amount
Customer invoice	$2,500
Subcontractor cost	$900
Employee labour cost	$300
Materials	$150
Travel	$100
Gross job profit	$1,050
Gross profit margin	42%

The calculation is:

\text{Job Profit}=\text{Job Revenue}-\text{Job Costs}\text{Margin}=\frac{\text{Job Profit}}{\text{Job Revenue}}\times100

But the application must separately track:

* Estimated profit: quoted revenue minus estimated costs.
* Actual gross profit: recognised job revenue minus actual incurred job costs.
* Customer outstanding: invoiced amount minus payments received and applicable credits.
* Supplier outstanding: approved supplier bills minus supplier payments and applicable credits.
* Cash position: actual customer receipts minus actual job-related cash payments.

Do not calculate profit from money received alone or count a subcontractor bill again when it is paid. Those are two different financial events.

Recoverable GST is never business revenue, profit or expense: GST collected on sales is owed to the ATO, and creditable GST on purchases is claimed back. Profit uses GST-exclusive amounts; only **non-creditable** GST forms part of a job cost.

5. Screens to develop

Dashboard

Revenue, job cost, profitability, outstanding invoices, pending contractor payments and recent jobs, all with date filters.

Jobs and work orders

Customer, work description, agreed price, technician assignment, due date, status, documents and job-specific financial summary.

Invoices and payments

Create invoice, generate PDF, mark sent, record partial payments, manage due dates and show unpaid balances.

Illustrative interface references. The application should use its own original design rather than copying MYOB’s branding or screens.

6. Access control

Role	Permissions
Owner	Complete access to all business and financial records
Manager	Create jobs, assign technicians, approve costs and view profits
Accountant (bookkeeper)	View and record invoices, expenses, payments, financial reports and draft GST/BAS summaries
Employee	View assigned jobs, submit hours, receipts and completion evidence
Subcontractor	View only their offers/jobs, submit invoices and completion evidence

Employees and subcontractors must never see your overall business profit, customer pricing or other contractors’ agreed rates unless explicitly authorised.

For version one, build the application for your own business with one company tenant. Even then, use company_id consistently to permit future expansion without rewriting the whole database.

7. Development steps

Build sequence and completion checklist

0 of 7 completed

0%

1. Foundation

Create the project, database, Docker configuration, authentication and roles.

2. Customers and jobs

Build customer CRUD, job numbers, work-order statuses and assignments.

3. Contractors and employees

Add contractor offers, approvals, employee time tracking and cost rates.

4. Financial records

Build expenses, supplier bills, customer invoices and separate payment entries.

5. Profit dashboard

Calculate job profit, margin, unpaid invoices, outstanding bills and cash position.

6. Documents and PDFs

Generate invoices and work orders; support authorised evidence uploads.

7. Testing and deployment

Implement financial tests, security testing, backups, HTTPS and deployment.

8. Ready-to-use development instructions for Codex

You can paste the following into Codex in an empty Git repository. It establishes the project specification, development conventions and first implementation milestone.

PROJECT: JobFlow - Job, Contractor and Financial Tracking
Build an original, production-oriented web application for
a small Australian contracting company.
BUSINESS MODEL
- The company receives jobs from customers.
- Jobs can be assigned to company employees or external
  subcontractors hired as needed.
- The company invoices customers and pays workers.
- The owner needs accurate job profitability, amounts
  received, amounts spent, and amounts still outstanding.
- Support 1-5 employees initially.
- Design for future growth.
IN SCOPE (GST — see docs/GST.md)
- Australian GST on invoice/bill lines, tax invoices,
  creditable GST, draft GST/BAS summaries (not lodged).
OUT OF SCOPE
- BAS lodgement or other tax lodgement.
- Superannuation calculations.
- PAYG withholding, STP submissions or payroll runs.
- Bank payment initiation.
- Direct MYOB/Xero integration in version 1.
- AI features in version 1.
TECHNOLOGY
- Next.js App Router with TypeScript
- Tailwind CSS and shadcn/ui
- PostgreSQL and Prisma ORM
- Established authentication library
- Server-side authorisation on every protected operation
- Docker Compose for local development
- Vitest and Playwright
- S3-compatible private document storage abstraction
BUSINESS REQUIREMENTS
1. Secure login, company owner, manager, accountant,
   employee and subcontractor roles.
2. Customers:
   - Create/edit/archive
   - Contacts, addresses, billing details
   - Customer-specific job and invoice history
3. Jobs:
   - Unique sequential job number per company
   - Customer, service location, description
   - Agreed customer price, dates, priority
   - Status: draft, quoted, approved, assigned,
     in_progress, awaiting_review, completed,
     invoiced, closed, cancelled
   - Support multiple visits and assignments
   - Record immutable history of status changes
4. Employees:
   - Assign employees to jobs
   - Record hours and internal hourly cost
   - Store historical cost-rate snapshots
   - No automated payroll calculations
5. Subcontractors:
   - Maintain contractor records
   - Create offers with agreed fees
   - Record accepted/rejected offers
   - Record contractor invoices and payments
   - Contractors see only authorised assignments
6. Expenses:
   - Labour, contractor fee, materials, travel,
     parking, equipment, miscellaneous
   - Job-specific or general company expense
   - Record category, amount, date, supplier
   - Approval status and receipt attachment
   - Committed and incurred costs separately
7. Customer invoices:
   - Unique sequential invoice number
   - Draft, issued, partially_paid, paid, void
   - Line items, due dates and PDF generation
   - Multiple invoices per job
   - Multiple partial payments per invoice
   - Credit note support
8. Supplier bills:
   - Record subcontractor/supplier liabilities
   - Support partial supplier payments
   - Prevent double-counting costs when paid
9. Financial dashboard:
   - Quoted job revenue and estimated profit
   - Actual incurred cost and gross job profit
   - Gross profit percentage
   - Customer invoice outstanding balances
   - Supplier bills outstanding balances
   - Cash received and cash paid
   - Filters by date, customer and job
   - CSV report export
FINANCIAL RULES
- Currency: AUD for version 1.
- Store monetary values as integer cents.
- Never use floating-point arithmetic for money.
- Never calculate profit solely from cash received.
- Never count a supplier bill and its payment as
  two different expenses.
- Record financial corrections through reversals
  or adjustment records, not silent edits.
- Prevent allocations exceeding allowed balances.
- Use transactions for multi-record changes.
- Use idempotency keys for payment creation.
- Separate invoice issue date from payment date.
- Preserve historical rate and price snapshots.
- Profit uses GST-exclusive amounts; recoverable GST
  is never revenue, profit or expense. Only
  non-creditable GST is part of job cost.
SECURITY
- Secure password storage/session handling
- Server-side role and object-level authorisation
- Deny access by default
- Private document storage and signed download URLs
- Validate all input on the server
- CSRF protections where applicable
- Rate limiting for authentication endpoints
- No secrets in Git
- Auditing for financial and permission changes
- Never expose internal profit to subcontractors
- No cross-company data access
INTERFACE
- Responsive desktop and mobile design
- Professional light/dark appearance
- Sidebar navigation
- Clear status badges and searchable data tables
- Accessible forms and confirmation dialogues
- Financial dashboard with useful charts
- Empty, loading and error states
- Original interface, not a MYOB clone
DEVELOPMENT APPROACH
First:
1. Inspect the repository before changing files.
2. Write docs/ARCHITECTURE.md.
3. Write docs/REQUIREMENTS.md.
4. Write docs/DATA_MODEL.md.
5. Write docs/SECURITY.md.
6. Write docs/IMPLEMENTATION_PLAN.md.
7. Define acceptance criteria for every module.
Then:
8. Scaffold the application and database.
9. Implement authentication and permissions.
10. Build customers and jobs first.
11. Add realistic seed/demo data.
12. Add automated tests for each feature.
13. Implement subsequent modules incrementally.
QUALITY GATES
- TypeScript strict mode.
- Schema validation on write operations.
- Database migrations version controlled.
- Unit tests for financial calculations.
- API integration tests for authorisation.
- End-to-end tests for the main workflow.
- Test backup and restoration procedures.
- Never deploy demo credentials to production.
- Do not declare a feature complete without tests.
CRITICAL ACCEPTANCE TEST
(Amounts are GST-exclusive / company not GST
registered. The GST-registered variant is in
docs/GST.md and must also pass.)
Create a customer job priced at $2,500.
Assign a subcontractor for $900.
Record employee labour costing $300.
Record materials costing $150.
Record travel costing $100.
Expected job cost: $1,450
Expected gross profit: $1,050
Expected gross margin: 42%
Issue a customer invoice for $2,500.
Record a partial receipt of $1,000.
Expected customer outstanding: $1,500.
Expected job gross profit remains $1,050.
Pay $400 against the subcontractor bill.
Expected supplier outstanding: $500.
Expected job cost remains $1,450.
Expected gross profit remains $1,050.
Test duplicate payment submissions, negative
amounts, unauthorised access, overpayments,
invoice voiding and correction workflows.
START WITH THE FOUNDATION AND THE FIRST WORKING
CUSTOMER-TO-JOB FLOW. DO NOT IMPLEMENT ALL MODULES
IN ONE UNTESTED CHANGE.

9. Important compliance and deployment decisions

Because the application will store financial information and employee work records, implement audit logging, secure backups, retention rules and exports from the beginning. Australian businesses generally need to retain most business records for five years; employee time and wage records generally need seven years.

Use a local development environment and a separate staging deployment with demonstration records before processing actual customer or employee information.

Demonstration records are stored in the database like real records but flagged as demo data, and the interface shows a persistent **"Demo Data"** indicator whenever they are present so they cannot be mistaken for real business records. Demo seeding is refused in production.

My recommendation is to build Customers → Jobs → Contractor Assignments → Costs → Invoices → Payments → Profit Reports in that order, with GST treatment built into costs, bills and invoices as they are created (not added afterwards). Payroll and superannuation remain out of scope. The milestone plan is in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Running the foundation scaffold (#8)

Requires Node.js 24.x (`nvm use`) and pnpm 9.15.4. Run `pnpm install --frozen-lockfile`, then `pnpm dev` and open http://localhost:3000. The home page is a placeholder; `/api/health` reports application liveness only. The placeholder and liveness endpoint can run without a database; integration tests require the local database setup below.

The root `pnpm typecheck` regenerates the ignored database client automatically, so install → type-check works on a fresh clone. Use `pnpm db:generate` explicitly before direct workspace database commands. Validation: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm build`. Browser smoke test: `pnpm exec playwright install chromium`, then `pnpm test:e2e`. Format new source with `pnpm format`; check with `pnpm format:check`.

Database tooling is provided by #9. Authentication, authorisation, tenancy and financial modules remain later issues. Follow the milestone dependencies before adding functionality. See [ADR 0001](docs/adr/0001-tech-stack.md).


## Local database and object storage (#9)

Requires Docker Engine with Compose v2 in addition to Node 24/pnpm. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:env
docker compose up --build -d --wait --wait-timeout 180
pnpm db:migrate
pnpm test:integration
```

`db:env` creates a private, ignored `.env` with random development credentials and refuses to overwrite
an existing file. [.env.example](.env.example) documents every setting. Keep it local; never reuse
these credentials or Compose roles in staging/production. Compose binds PostgreSQL to loopback 5432,
MinIO API to loopback 9000 and its console to loopback 9001. Adjust the ports **and database URLs**
together in `.env` if occupied. MinIO builds pinned official source because upstream prebuilt
artifacts are unavailable; the first build can take several minutes. See [ADR 0002](docs/adr/0002-local-database.md)
for provenance, licensing and operational limits. No public buckets or upload features exist yet.

`jobflow` is the development database; `jobflow_test` is the base used to provision a fresh
`jobflow_test_<uuid>` database for each integration run. The runner migrates the unique database,
passes its URL only to that run, and drops it on completion, failure or normal interruption.
Tests never reset the development database. The local test role needs CREATEDB; the default
Compose development role is an administrator and must never be used by a production application.
A hard kill or host/database failure may leave an abandoned temporary database; inspect exact names
before manually removing one. Never drop databases by wildcard.

For an existing database server, set `DATABASE_URL` and `TEST_DATABASE_URL` in the process environment
(or root `.env`), create those two UTF8 databases, and grant the local test role CREATEDB. Test/reset
helpers accept only loopback `jobflow_test`, no URL query/fragment options, and reject production
mode or the same development database. Process environment values override `.env`.

Migration commands:

- `pnpm db:validate` validates the schema without a server.
- `pnpm db:generate` regenerates the ignored TypeScript Prisma client.
- `pnpm db:migrate` applies committed migrations (safe to repeat).
- `pnpm db:migrate:dev -- --name <change>` creates a development migration; review SQL and commit it.
- `RESET_TEST_DATABASE=yes pnpm db:test:reset` destructively resets **only local jobflow_test** and reapplies migrations.

The bootstrap migration creates only Prisma migration history; business/tenancy tables arrive in #12.
Prisma uses forward migrations, not automatic down migrations. Stop services with `docker compose down`
to preserve volumes. `docker compose down --volumes` deletes **all local Compose database and MinIO data**;
use it only for disposable environments. Initial test-database creation runs only on a fresh volume.
There is no demo seed until its own milestone issue; demo rules and production refusal remain required.
