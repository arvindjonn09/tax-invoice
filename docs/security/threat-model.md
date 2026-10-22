# JobFlow v1 threat model

Status: proposed for architect, QA and code review; implementation controls are not yet verified.
Prepared 22 October 2026 for #24. Scope follows [architecture](../ARCHITECTURE.md),
[requirements](../REQUIREMENTS.md), [security policy](../SECURITY.md) and [financial rules](../GST.md).
This is a design analysis, not a penetration test or a claim of production readiness.

## Scope, assets and assumptions

V1 is a modular monolith: browser → Next.js server/service → Prisma/PostgreSQL, private object storage,
and server-side PDF/CSV output. Local, staging and production have separate databases, storage and keys.
The server, not browser fields or route parameters, establishes actor identity and company membership.
One company in v1 does not remove the tenant boundary; negative tests must create two synthetic companies.
BAS lodgement, payroll, bank-payment initiation, external accounting integrations and AI are outside scope.

| Asset | Security property and consequence of failure |
|---|---|
| Invoices, quotes, bills, credits and GST snapshots | Integrity and restricted access; forged or retrospectively changed records corrupt customer balances and draft GST |
| Receipt/payment allocations and idempotency records | Atomicity and uniqueness; retries/concurrency must not allocate twice or overpay |
| ABNs, bank details, customer contacts and locations | Confidentiality; exposure enables fraud or unwanted disclosure |
| Employee hours, historical cost rates and contractor offers | Confidentiality and integrity; workers must not infer other workers' rates, selling prices or margins |
| Uploaded tax invoices, receipts, signatures, photos and PDFs | Private, authorised access; hostile files must not execute or escape their storage/rendering boundary |
| Sessions, memberships, secrets and backups | Confidentiality and recovery; compromise enables tenant access or complete data loss |
| Audit events, locks and issued-document snapshots | Append-only history and attribution; destructive changes must remain detectable |
| Demo data and environment identity | Production isolation and unmistakable labelling; synthetic balances must not be mistaken for actual accounts |

Threat actors include unauthenticated internet clients, a compromised user browser/session, a malicious employee or
subcontractor with legitimate access, and accidental or malicious privileged operators. Hosting/storage administrators
remain a residual privileged threat; backups and database credentials require separate least-privilege access.

## Trust boundaries and data flow

1. **Browser → server:** cookies, URL IDs, forms, JSON, upload metadata and forwarded headers are untrusted.
   Every route, server action, report, export and file-signing operation authenticates and authorises independently.
2. **Identity → company/object permissions:** resolve active membership server-side; validate role, current assignment
   and ownership. Client-selected company/role IDs confer no access. Explicit safe response projections prevent leaks.
3. **Service → database:** parameterised Prisma operations, tenant-scoped joins, composite constraints and transactions
   preserve references and financial invariants even under simultaneous requests. Shared caches must include scope or
   be disabled for sensitive data; a successful earlier check is not permanent permission.
4. **Service → storage:** bucket is private; generate opaque object keys, validate metadata/content, then authorise
   each upload/download. Signed links are temporary bearer credentials and must not enter logs or public HTML.
5. **Untrusted data → renderer/export → recipient:** escape text, prohibit renderer network/filesystem access and
   neutralise spreadsheet formulas. Generated documents inherit source-object permissions and private caching.
6. **Application → operations:** CI, logs, secrets, deployments and backup stores have separate privileges and keys.
   Untrusted PR jobs must not receive deployment credentials. Restore testing uses isolated synthetic environments.

## STRIDE register and mitigation ownership

Risk is qualitative: **High** means unauthorised financial/PII access, material financial corruption or broad compromise;
**Medium** means bounded availability or operational exposure. These are prospective scenarios, not confirmed bugs.
Issue links identify required implementation and verification, not completed controls. Every High risk has an owner issue.

| ID / category / risk | Concrete abuse scenario | Required control and mitigation issues |
|---|---|---|
| T01 Spoofing / High | Stolen session, brute-force login or forged role grants privileged access | Maintained auth library, secure cookies, session expiry/revocation, login throttling; assess privileged MFA: [#13](https://github.com/arvindjonn09/tax-invoice/issues/13), [#27](https://github.com/arvindjonn09/tax-invoice/issues/27), [#71](https://github.com/arvindjonn09/tax-invoice/issues/71) |
| T02 Elevation of privilege / High | Employee changes company/job ID, or subcontractor requests another offer/file/export | Deny by default; active membership plus object/assignment checks, tenant-safe relations, positive field allowlists: [#12](https://github.com/arvindjonn09/tax-invoice/issues/12), [#14](https://github.com/arvindjonn09/tax-invoice/issues/14), [#32](https://github.com/arvindjonn09/tax-invoice/issues/32), [#37](https://github.com/arvindjonn09/tax-invoice/issues/37), review [#43](https://github.com/arvindjonn09/tax-invoice/issues/43) |
| T03 Information disclosure / High | Hidden prices/rates arrive in page hydration, JSON, counts, cached responses, PDFs or CSV | Server projections and private/no-store responses; scope aggregates and exports like detail records: [#14](https://github.com/arvindjonn09/tax-invoice/issues/14), [#43](https://github.com/arvindjonn09/tax-invoice/issues/43), [#56](https://github.com/arvindjonn09/tax-invoice/issues/56), [#71](https://github.com/arvindjonn09/tax-invoice/issues/71) |
| T04 Tampering / High | Two retries allocate the same receipt twice, or a forged allocation links another company's bill | Transactional scoped allocation, atomic outstanding-balance check, scoped idempotency key and payload conflict handling: [#46](https://github.com/arvindjonn09/tax-invoice/issues/46), [#50](https://github.com/arvindjonn09/tax-invoice/issues/50), race suite [#52](https://github.com/arvindjonn09/tax-invoice/issues/52) |
| T05 Tampering / High | Client rewrites issued amount, rate snapshot, GST registration date or locked-period transaction | Authorised state transitions, immutable snapshots, credit/void/reversal and adjustment only; calculate GST/profit together on server: [#15](https://github.com/arvindjonn09/tax-invoice/issues/15), [#17](https://github.com/arvindjonn09/tax-invoice/issues/17), [#25](https://github.com/arvindjonn09/tax-invoice/issues/25), [#47](https://github.com/arvindjonn09/tax-invoice/issues/47), [#55](https://github.com/arvindjonn09/tax-invoice/issues/55) |
| T06 Repudiation / High | User approves an expense or changes access, then denies it; partial write loses its audit | Business mutation and append-only audit in same transaction; actor, company, target, action, time and safe change metadata: [#15](https://github.com/arvindjonn09/tax-invoice/issues/15), [#52](https://github.com/arvindjonn09/tax-invoice/issues/52), review [#53](https://github.com/arvindjonn09/tax-invoice/issues/53) |
| T07 Information disclosure / High | Attacker guesses object key, obtains cross-tenant signed link or opens uploaded HTML in app origin | Private bucket, random keys, authenticated signing, short expiry, safe attachment/content headers, type/size validation: [#34](https://github.com/arvindjonn09/tax-invoice/issues/34), review [#43](https://github.com/arvindjonn09/tax-invoice/issues/43) |
| T08 Tampering / elevation / High | Stored HTML executes in invoice view; hostile PDF asset URL reads local files/cloud metadata; CSV executes formula | Escaped templates and UI, bounded renderer with no arbitrary network/local file access, safe CSV cells: [#48](https://github.com/arvindjonn09/tax-invoice/issues/48), [#70](https://github.com/arvindjonn09/tax-invoice/issues/70), CSP [#71](https://github.com/arvindjonn09/tax-invoice/issues/71) |
| T09 Spoofing / tampering / High | External site submits a privileged mutation using an existing session | CSRF/origin protection for every mutation including server actions; safe cookies and no state-changing GET: [#13](https://github.com/arvindjonn09/tax-invoice/issues/13), [#71](https://github.com/arvindjonn09/tax-invoice/issues/71) |
| T10 Denial of service / Medium | Large uploads, unbounded report ranges or repeated PDF generation exhaust workers/storage | Body/file limits, bounded pagination, actor/IP throttles, renderer time/memory/concurrency limits: [#34](https://github.com/arvindjonn09/tax-invoice/issues/34), [#70](https://github.com/arvindjonn09/tax-invoice/issues/70), [#71](https://github.com/arvindjonn09/tax-invoice/issues/71), monitoring [#64](https://github.com/arvindjonn09/tax-invoice/issues/64) |
| T11 Information disclosure / High | Error/log includes signed URL, ABN, bank details or session; backup or CI key leaks | Redaction and safe errors, CI secret/dependency/static checks, distinct keys, encrypted backups and restricted operators: [#10](https://github.com/arvindjonn09/tax-invoice/issues/10), [#63](https://github.com/arvindjonn09/tax-invoice/issues/63), [#64](https://github.com/arvindjonn09/tax-invoice/issues/64), [#71](https://github.com/arvindjonn09/tax-invoice/issues/71) |
| T12 Tampering / High | Demo seed runs in production or demo totals enter an unlabelled actual report | Fail closed on production seeding/credentials; persistent DB-derived Demo Data indicator: [#21](https://github.com/arvindjonn09/tax-invoice/issues/21), [#20](https://github.com/arvindjonn09/tax-invoice/issues/20), staging verification [#65](https://github.com/arvindjonn09/tax-invoice/issues/65) |
| T13 Denial of service / High | Database/storage loss or ransomware makes financial history unrecoverable | Encrypted isolated backups, restoration with DB/file consistency and documented recovery/incident procedure: [#63](https://github.com/arvindjonn09/tax-invoice/issues/63), [#64](https://github.com/arvindjonn09/tax-invoice/issues/64), [#66](https://github.com/arvindjonn09/tax-invoice/issues/66) |

## Required negative tests and evidence

These are implementation acceptance cases for the linked issues. This documentation PR does not supply runnable
application tests: the base has specifications only. Run these in CI as their modules land; do not mark them passed here.

| Test | Expected outcome | Owner issues |
|---|---|---|
| Anonymous, disabled membership, every role; swap company and related object IDs on reads/writes/list/search/count/report/export/signing | Denied without sensitive fields or existence clues; no writes/audit side effects from denied requests | #12, #14, #27, #43, #53 |
| Employee requests unassigned job; contractor requests another offer or customer financial fields; inspect HTML, RSC payload, JSON, PDF and CSV | Only own permitted objects/fields; no prices, margins, other workers' rates or unrelated files | #32, #37, #43 |
| Revoke role/assignment between requests, reuse session and warmed cache across users/tenants | Current permissions apply; no stale cross-user payload; no shared caching of sensitive responses | #13, #14, #71 |
| Simultaneous duplicate receipt/supplier allocation requests; same key with changed payload; cross-tenant key collision; two distinct keys overpay same balance | One committed effect for retry; conflicting payload rejected; no overpayment, cross-company link or partial state; audit consistent | #46, #50, #52 |
| Modify approved record, issued invoice, historical rate or locked period; induce audit write failure | Direct edit rejected; allowed correction appends history; financial transaction rolls back if audit fails | #15, #47, #52, #55 |
| Registered/unregistered combined fixture plus non-creditable GST; receipts/payments and malicious client totals | Server authoritative cents; profit unchanged by payment/recoverable GST; GST and profit asserted together | #17, #52, #54, #55, #59 |
| Guess storage keys; direct public GET; expired link; cross-tenant signing; oversized, extension/MIME mismatch and active-content file | No public/cross-tenant access; links expire; reject disallowed content; safe attachment response | #34, #43 |
| HTML/script text, renderer localhost/private network/metadata and local-file URLs; formula-leading CSV cells including whitespace/control prefixes | Escaped output; no renderer fetch/read; no executable formulas; safe errors | #48, #56, #70 |
| Cross-origin POST/action, malformed body, repeated login/export/signing, huge page size | Reject CSRF/invalid input; enforce limits; safe error and security headers | #13, #71 |
| Synthetic secret/ABN/contact markers through errors, logs and signed URL access | No sensitive markers/tokens/URLs in logs or client diagnostics | #71 |
| Seed with production identity; demo company on all supported screens; isolated backup restoration | Seed refused; persistent indicator; restored DB/files reconcile with access restrictions intact | #20, #21, #63, #65 |

## Residual risks and release gates

- An authorised privileged user can export data and change permitted settings. Audit and least privilege reduce this
  risk but do not prevent misuse. Accountant/owner permissions must be explicit; ambiguity defaults to denial (#14).
- A signed URL can be shared until expiry; it is not a session-bound permission. Keep lifetimes short, avoid logging it,
  document this limitation and decide whether particularly sensitive downloads require server proxying in #34.
- Malware protection feasibility and upload quarantine/fail-closed policy must be decided in #34 and verified in #43;
  an allowlisted MIME type alone is insufficient. Privileged MFA choice is a recorded decision for #13, not assumed enabled.
- Backups do not prove recovery until the isolated restore drill passes (#63). Retention/deletion policy awaits #62;
  do not invent legal retention guarantees from this threat model.
- #70 and #71 capture gaps discovered during this analysis; all linked controls are planned. Dependency ordering
  does not permit enabling an affected endpoint before its security acceptance cases pass.
- Before pilot: architect reviews boundaries and mitigation ownership; QA/code reviewer review this model and the
  resulting tests. #61 refreshes it against actual routes, dependencies, hosting and residual findings. No open
  Critical/High findings may remain; #67 separately validates GST outputs. Owner checkpoints remain in force.
