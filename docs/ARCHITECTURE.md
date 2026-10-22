# Architecture

## Design
Modular monolith. Next.js App Router, TypeScript strict, React, Tailwind/shadcn; Node service layer and API endpoints using Zod; PostgreSQL with Prisma migrations; maintained authentication library; S3-compatible private document storage; PDF generation and CSV exports.

## Structure
```text
apps/web/src/app/
apps/web/src/features/{dashboard,customers,jobs,quotes,employees,contractors,costs,invoices,payments,reports}/
packages/{database,domain,authz,shared-types}/
infra/{docker,nginx}/
tests/
docs/
```

## Data ownership
App is authority for jobs, assignments, operational costs, its own invoices, manual receipts/payments. Future MYOB/Xero integration must explicitly declare sync direction; external accounting remains authority for tax/payroll data.

## Key rules
All API mutations authenticate actor, resolve company membership server-side, validate input and object-level permission. Store receipts privately and access via short-lived signed URLs. Sensitive writes transactional and auditable; external retries idempotent.

## Environments
Separate local/staging/production databases, file stores and keys. TLS in production, least-privilege DB users, encrypted daily backups and verified restores. No real customer data in tests. Logging with request/job IDs but no secrets. Start without Redis until queue needs justify it.

## Integration
V1 CSV export with explicit schema; later OAuth MYOB/Xero with encrypted tokens, reconciliation, error queue and API rate limit handling.