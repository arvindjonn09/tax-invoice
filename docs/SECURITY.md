# Security and operations

- Owner/manager/accountant/employee/subcontractor permissions enforced server-side on every API, report, export and file download. Deny by default.
- Authenticate securely with a maintained framework, strong password hashes, safe sessions and MFA for privileged users where possible. Validate session on mutations; protect CSRF, throttle login.
- Subcontractors cannot see customer sales prices, internal margins, unrelated files, other contractors or payroll-sensitive details. Employees see only their assignments.
- Reject forged company_id/job_id access, apply tenant filters to all queries and joins.
- Immutable financial audit log, sequential invoice identity, price and tax-code snapshots, approval rules, no destructive edits to issued records.
- GST settings (registration dates, accounting basis) and period locks are privileged, audited changes; locked periods cannot be altered except through recorded adjustments.
- Use DB transactions and idempotency keys for financial allocations and retries.
- ABNs, tax invoices, bank and contact details are sensitive: least-privilege access, never logged, never in seeds or tests as real values.
- Private file buckets, controlled MIME types/sizes, malware protection where feasible, signed expiring links, no direct arbitrary paths.
- Demo data is flagged and visibly labelled; demo seeding and demo credentials are refused in production.
- TLS, encrypted backups, tested restore, secret manager or deployment env vars, least privilege, dependency scans, logs without sensitive data.
- CI on every PR: type-check, lint, tests (incl. authorisation and tenant isolation), dependency audit, secret scanning and static analysis. `main` is protected and requires these checks.
- Australian business records (generally 5 years), workplace records (generally 7 years) and privacy obligations apply. The app calculates GST and produces **draft** BAS figures but does not lodge, and does not handle superannuation or payroll. Obtain professional advice before real usage.
- Production release requires RBAC/tenant isolation tests, safe file-upload tests, a backup restore exercise, a staging smoke test, monitoring and an incident plan.
