# Security and operations

- Owner/admin/bookkeeper/employee/contractor permissions enforced server-side on every API, report, export and file download.
- Authenticate securely with maintained framework, strong hashes, safe sessions and MFA for privileged users where possible. Validate session on mutations; protect CSRF, throttle login.
- Contractors cannot see customer sales prices, internal margins, unrelated files, other contractors or payroll-sensitive details.
- Reject forged company_id/job_id access, apply tenant filters to all queries and joins.
- Immutable financial audit log, sequential invoice identity, price snapshots, approval rules, no destructive edits to issued records.
- Use DB transactions and idempotency keys for financial allocations and retries.
- Private file buckets, controlled MIME/types/sizes, malware protection where feasible, signed expiring links, no direct arbitrary paths.
- TLS, encrypted backup, tested restore, secret manager or deployment env vars, least privilege, dependency scans, logs without sensitive data.
- Australian business records, workplace records and privacy obligations may apply even though this app intentionally does not calculate GST/super/payroll. Obtain professional advice before real usage.
- Production release requires RBAC/tenant isolation tests, safe file-upload tests, backup restore exercise, staging smoke test, monitoring and incident plan.