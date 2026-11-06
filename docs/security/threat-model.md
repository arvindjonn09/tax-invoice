# JobFlow v1 threat model

Status: architect and QA design/specification review completed on 22 October 2026 with no blocking findings.
Implementation controls and their security effectiveness remain unverified; this is not release approval.
Prepared 22 October 2026 for #24. Scope follows [architecture](../ARCHITECTURE.md),
[requirements](../REQUIREMENTS.md), [security policy](../SECURITY.md) and [financial rules](../GST.md).
This is a design analysis, not a penetration test or a claim of production readiness.

M6 update, 4 November 2026, for #207: threats T14–T22 cover public sign-up, email, trial and the platform operator, from
[ADR 0004](../adr/0004-public-signup-and-trial.md), the [requirements](../requirements/public-signup-trial.md) and the
[contracts](../architecture/public-signup-trial.md). They describe the design. `main` at 85ba5b8 holds the trial clock,
the account, outbox and access-mode schema, the email outbox with its SMTP transport, the read-only guard (#255, #256,
#257) and the sign-up API with email verification (#249). It doesn't hold onboarding, the operator area, the logo API or
the Cloudflare edge configuration. Onboarding (#250), email pacing (#266) and malware scanning (#261) are open PRs, and
details taken from them can still change. T14–T22 haven't had
the design review recorded for T01–T13.

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
| Verification and reset tokens, outbox payloads and account existence | Confidentiality and single use; a leaked token takes over an account, and an existence oracle shows who uses JobFlow |
| Company trial state (`access_mode`, `trial_last_day`, `read_only_from`) | Integrity; a wrong value gives free use for life or locks a customer out of writing |
| Operator role, TOTP secrets, enrolment codes and Cloudflare Access policy | Confidentiality and integrity; compromise changes access for every company and exposes owner names and emails |
| Sending mailbox, its hourly limit and domain reputation | Availability; abuse delays or blocks verification and reset email for everyone |

Threat actors include unauthenticated internet clients, a compromised user browser/session, a malicious employee or
subcontractor with legitimate access, and accidental or malicious privileged operators. Hosting/storage administrators
remain a residual privileged threat; backups and database credentials require separate least-privilege access.
M6 adds a bot or person who mass-creates accounts, enumerates emails or restarts trials; any stranger who can become a
company owner in minutes, so owner-only features now face untrusted users; and the platform operator. Cloudflare and Zoho
are processors: Cloudflare terminates TLS and Zoho carries the emailed links.

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
7. **Cloudflare edge → origin (M6):** only the header set by the one trusted hop may identify the client. Anything that
   reaches the origin without passing the edge skips Turnstile's widget, cache rules and Cloudflare Access.
8. **Application → mailbox (M6):** an emailed link is a bearer credential once it leaves the outbox. Recipients at
   unverified addresses may be strangers, so those emails carry no user-entered text.
9. **Company users → platform operator (M6):** the operator is outside the company role model and never gains company
   data. Tenant-entered text shown to the operator (company names, request messages) is untrusted.

## STRIDE register and mitigation ownership

Risk is qualitative: **High** means unauthorised financial/PII access, material financial corruption or broad compromise;
**Medium** means bounded availability or operational exposure. These are prospective scenarios, not confirmed bugs.
Issue links identify required implementation and verification, not completed controls. Every High risk has an owner issue.

**Two numbering schemes meet in T14–T22.** Threat IDs (T01–T22) appear in the first column of this register, and
elsewhere as "threat Tn" or a bare ID in brackets after a residual-risk heading. "Delivered by Tn" and "task Tn" name a
task in [public-signup-trial-tasks.md](../architecture/public-signup-trial-tasks.md), linked to its issue, so threat T14
and task T14 are different things. "Control (ADR 0004 Dn), delivered by Tn" states what the design requires, not what is
built.

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
| T14 Spoofing / denial of service / Medium | A bot registers accounts in bulk, or one person takes a new mailbox and the same ABN each month to restart the 30-day trial | Control (ADR 0004 D1, D8), delivered by T13 ([#217](https://github.com/arvindjonn09/tax-invoice/issues/217)), T14 ([#218](https://github.com/arvindjonn09/tax-invoice/issues/218)): Turnstile verified on the server for `success`, hostname and action, failing closed; IP throttle 5/h; a verified email before any company access; `SIGNUP_ENABLED` kill switch. Control (ADR 0004 D3), delivered by T16 ([#220](https://github.com/arvindjonn09/tax-invoice/issues/220)): one self-service company per user (`self_service_owner_id`), strict onboarding schema that refuses trial dates, `isDemo` and `role`. Restarting with a new mailbox isn't prevented (see residual risks) |
| T15 Information disclosure / Medium | An attacker compares sign-up, resend and forgot-password responses or timing to learn who has an account; or signs up, invites an address and reads the accept response | Control (ADR 0004 D1), delivered by T13 ([#217](https://github.com/arvindjonn09/tax-invoice/issues/217)), T14 ([#218](https://github.com/arvindjonn09/tax-invoice/issues/218)), T15 ([#219](https://github.com/arvindjonn09/tax-invoice/issues/219)): identical 202 for every account state, the same password hashing work on both paths, a silent per-recipient cap, median timing difference under 50 ms measured by T31 ([#235](https://github.com/arvindjonn09/tax-invoice/issues/235)). Operator failures return 404 (ADR 0004 D2, D5), delivered by T26 ([#230](https://github.com/arvindjonn09/tax-invoice/issues/230)). The invitation response has no ADR control or task yet (see residual risks) |
| T16 Spoofing / denial of service / Medium | An attacker signs up with strangers' addresses to send them mail, puts spam text in a name field, or bursts sign-ups to use up Zoho's limit so that real verification and reset email stops | Control (ADR 0004 D1, D7), delivered by T10 ([#214](https://github.com/arvindjonn09/tax-invoice/issues/214)), T11 ([#215](https://github.com/arvindjonn09/tax-invoice/issues/215)), T12 ([#216](https://github.com/arvindjonn09/tax-invoice/issues/216)), T13 ([#217](https://github.com/arvindjonn09/tax-invoice/issues/217)): no user-entered text in email to unverified addresses, at most 1 "account exists" email per hour and 3 per day per address, resend limits, suppression list, SPF/DKIM/DMARC. Pacing and account-email priority are in [#266](https://github.com/arvindjonn09/tax-invoice/pull/266), open ([#259](https://github.com/arvindjonn09/tax-invoice/issues/259)) |
| T17 Spoofing / information disclosure / High | A reset or verification token leaks through access logs, `Referer`, a link scanner, application logs or the outbox, and is replayed; or a forged `Host` puts an attacker's domain in the emailed link | Control (ADR 0004 D1, D7), delivered by T10 ([#214](https://github.com/arvindjonn09/tax-invoice/issues/214)), T14 ([#218](https://github.com/arvindjonn09/tax-invoice/issues/218)), T15 ([#219](https://github.com/arvindjonn09/tax-invoice/issues/219)), T20 ([#224](https://github.com/arvindjonn09/tax-invoice/issues/224)): 256-bit tokens stored only as SHA-256, single use, 24 h and 1 h lifetimes, a new token supersedes the old; the token sits in the URL fragment and the page POSTs it, then removes it from history; `Referrer-Policy: no-referrer`; AES-256-GCM outbox payload nulled after sending; links built from `BETTER_AUTH_URL`; a reset deletes all sessions; Better Auth's own reset and verification endpoints stay disabled |
| T18 Spoofing / High | Behind Cloudflare Tunnel, X-Forwarded-For keeps what the client sent. A client that rotates that header gets a new throttle key per request, which defeats sign-in, sign-up and export limits; or a client reaches the origin directly and sends its own `CF-Connecting-IP` | Control (ADR 0004 D8), delivered by T9 ([#213](https://github.com/arvindjonn09/tax-invoice/issues/213)): one trusted hop, no published origin ports, and a test that spoofed headers aren't trusted. Where the tunnel reaches the app without the D8 nginx, throttles must use `CLIENT_IP_HEADER=cf-connecting-ip` with the origin bound to loopback ([#249](https://github.com/arvindjonn09/tax-invoice/pull/249), merged). ADR 0004 D8 records one IP source per deployment, and the nginx template drops a client-sent `CF-Connecting-IP`. #249 also ignores header values that aren't IP addresses |
| T19 Information disclosure / tampering / High | The edge caches one user's page or JSON and serves it to another, a crafted URL such as `/invoices/x.css` is stored as a static file, or a response poisoned by an unkeyed header is served to everyone | Control (ADR 0004 D8), delivered by T9 ([#213](https://github.com/arvindjonn09/tax-invoice/issues/213)): one Cache Rule bypasses everything except `/_next/static/*`; Rocket Loader, Email Obfuscation, Auto Minify, Always Online, Mirage and Zaraz are off; `scripts/ops/check-edge-cache.mjs` proves on staging that no app page or API returns `cf-cache-status: HIT` for two users. `private, no-store` stays on every dynamic response, asserted by T19 ([#223](https://github.com/arvindjonn09/tax-invoice/issues/223)). The check is repeated at launch by T32 ([#236](https://github.com/arvindjonn09/tax-invoice/issues/236)) |
| T20 Tampering / elevation of privilege / Medium | The owner of an expired company keeps writing through a route the guard misses, a write that sets no audit event, an exempt transaction that also changes other rows, or a mass-assigned `access_mode`, `trial_last_day` or `read_only_from` | Control (ADR 0004 D3, D4), delivered by T7 ([#211](https://github.com/arvindjonn09/tax-invoice/issues/211)), T17 ([#221](https://github.com/arvindjonn09/tax-invoice/issues/221)), T18 ([#222](https://github.com/arvindjonn09/tax-invoice/issues/222)): `withPolicy` refuses unsafe methods unless listed in `READ_ONLY_ALLOWED`; a commit-time trigger on `audit_events` uses database time; exemption keys are transaction-local and admit only their own audit actions; `read_only_from` is set by trigger; every unsafe route is tested. Hardening of trial columns, the export audit and route policy: [#260](https://github.com/arvindjonn09/tax-invoice/issues/260). The guard is merged ([#257](https://github.com/arvindjonn09/tax-invoice/pull/257)) |
| T21 Elevation of privilege / spoofing / High | An attacker phishes or resets the operator's password, enrols their own authenticator first, or stores a script in a company name for the operator's browser; or operator scope grows until it reaches company data or a second, weaker admin path appears | Control (ADR 0004 D5, D6), delivered by T26 ([#230](https://github.com/arvindjonn09/tax-invoice/issues/230)), T27 ([#231](https://github.com/arvindjonn09/tax-invoice/issues/231)), Access by T9 ([#213](https://github.com/arvindjonn09/tax-invoice/issues/213)): two keys (`platform_operators` row and `JOBFLOW_OPERATOR_USER_IDS`); grant and revoke only by host CLI; TOTP required in production with a host-issued enrolment code; Cloudflare Access on the operator paths; every failure returns 404; positive-allowlist projections with key-set tests; every action audited; the runtime role can't write `platform_operators`. Route rule (ADR 0004 D2): `app/api/operator/**` uses only `withOperator`. [#254](https://github.com/arvindjonn09/tax-invoice/pull/254)'s `/admin-console` is that kind of second path, so by owner decision (5 November) it stays off and unmerged until after go-live |
| T22 Tampering / elevation of privilege / High | An owner uploads SVG with script, HTML renamed to `.png`, a PNG/ZIP or JPEG/HTML polyglot, a decompression bomb or an image carrying malware or private EXIF data, aimed at the app origin, the PDF renderer or customers who receive the PDF | ADR 0004 has no logo decision. Control ([contracts, Logo storage](../architecture/public-signup-trial.md#logo-storage-s6), requirement S6), delivered by T23 ([#227](https://github.com/arvindjonn09/tax-invoice/issues/227)), T25 ([#229](https://github.com/arvindjonn09/tax-invoice/issues/229)): PNG or JPEG file signature only; at most 2 MiB and 4000 × 4000; metadata chunks stripped; random key in private storage; 5-minute signed link through `/api/files/[token]`, which serves an attachment with `sandbox` CSP and `nosniff`; PDF embeds private bytes and never fetches a URL. Refused while read-only (ADR 0004 D4, T18 ([#222](https://github.com/arvindjonn09/tax-invoice/issues/222))). Not built. Malware scan: [#136](https://github.com/arvindjonn09/tax-invoice/issues/136), [#261](https://github.com/arvindjonn09/tax-invoice/pull/261), open; it scans every upload on a built app, logos included, and refuses password-protected PDFs by owner decision (5 November) |

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

### M6 negative tests (tasks T13–T18, T26 and T27)

These tasks must include the tests below, and none has been run as part of this document. Some sign-up and guard tests
exist on the open PR branches; they count when their PRs merge and these outcomes are confirmed. The last column names
tasks, then the threats each test covers.

| Test | Expected outcome | Owner task and threats |
|---|---|---|
| Sign up with new, unverified, verified, invited, deactivated and demo emails; compare status, body and headers; measure timing over 200 runs | Identical 202; existing account unchanged; median difference under 50 ms; two concurrent same-email requests create 1 user and both get 202 | Task T13 (#217); threats T14, T15 |
| Missing, invalid and expired Turnstile token; wrong hostname or action; `siteverify` timeout; no secret configured in production | Generic 400, or refusal in production; no user, token or email is created | Task T13 (#217); threat T14 |
| Sixth sign-up from one IP; rotate X-Forwarded-For with `CLIENT_IP_HEADER=cf-connecting-ip` set; send a non-IP header value; omit the header | 429 with retry time; rotation gets no new key; a non-IP value creates no key | Task T13 (#217), task T9 (#213); threat T18 |
| Repeat sign-up for one existing address from many IPs; a name containing a URL, HTML or CR/LF; extra body keys; reserved TLD and placeholder legal version in production | At most 1 email per hour and 3 per day with the same 202; no user-entered text in the email and no injected header; unknown keys give 400; reserved TLD refused; legal gate gives 503 | Task T13 (#217); threats T14, T16 |
| Better Auth `/sign-up/email`, `/verify-email` and reset endpoints called directly | Disabled; no user, token or email | Tasks T13 (#217), T15 (#219); threats T14, T17 |
| Verification token expired, consumed, superseded, tampered and of the wrong purpose; two concurrent uses; GET of the link with no script; token in a query string | Generic 400 with no change; exactly one concurrent use succeeds; GET consumes nothing; the query-string form is ignored | Task T14 (#218); threat T17 |
| Run sign-up and verify, then search logs, audit metadata, `platform_audit_events` and the outbox row for a marker token and address | No plaintext token or address; only the digest and ciphertext are stored; the page sends `Referrer-Policy: no-referrer` and removes the fragment | Task T14 (#218); threat T17 |
| Unverified, pre-existing and invited users call every company API; accept an invitation for an address the inviter controls; reserved-TLD account with production identity | 403 `email_unverified`; accepting doesn't set `email_verified`; the reserved-TLD exemption doesn't apply in production | Task T14 (#218); threats T14, T17 |
| Public resend for unknown, verified and unverified addresses; exceed 1/min and 5/day | Identical 202 in every case; no email beyond the limits | Task T14 (#218); threats T15, T16 |
| Forgot password for existing, unknown, demo and throttled accounts; measure timing | Identical 202; similar timing; throttled requests send nothing and are counted without PII | Task T15 (#219); threats T15, T16 |
| Reuse a reset token; use an expired or superseded link; send a forged `Host` and `X-Forwarded-Host`; keep an old session across a reset; reset a deactivated member and an operator with TOTP | Replay and old links give `token_invalid`; the link uses `BETTER_AUTH_URL`; every old session fails; no membership is reactivated; TOTP stays enrolled | Task T15 (#219); threats T17, T21 |
| Onboarding body with `companyId`, `isDemo`, trial dates or `role`; different key after success; concurrent same key; inject a failure at each step; switch to a company where the user has no active membership | 400 for forbidden keys; 409 `self_service_limit`; 1 company; nothing left behind; a new company is always `trial`; switching gives 404 | Task T16 (#220); threats T14, T20 |
| Employee and subcontractor read trial status; request a forged company or date; demo and `unrestricted` companies; Sydney midnight and DST boundaries | Exact key sets (`{ readOnly }` only for those roles); no forged input is used; demo and `unrestricted` are never read-only; phase matches `packages/domain` | Task T17 (#221); threat T20 |
| Call every unsafe route as owner of an expired company, including a route that re-exports a handler under another method; `PATCH /api/company` with trial columns (#260) | 403 `company_read_only` outside `READ_ONLY_ALLOWED`; route-policy test fails on an unguarded export; trial columns unchanged | Task T18 (#222), #260; threat T20 |
| Declare each exemption key with an unrelated audited action; a null, unknown or stale key; a key set in one transaction then reuse the pooled connection; role change under `access_removal`; invitation issued after `read_only_from`; commit racing expiry | Rolled back with no partial rows; the key doesn't carry over; role change refused; invitation gets 403; a write that commits after expiry is rolled back unless an extension committed first | Task T18 (#222); threat T20 |
| Static check of company-table writes outside `withAudit`; GET export with extra free-text and `documentId` parameters (#260) | The check fails on a new unaudited write unless it is listed with a reason; only validated fields reach the audit row | Task T18 (#222), #260; threat T20 |
| Every operator page and API as signed-out, each of the five company roles, revoked operator, row without allowlist, allowlist without row, unverified email and, in production, no MFA | Same 404 for all; no link, content or side effect reveals the area | Task T26 (#230); threat T21 |
| Password-only session calls `/two-factor/enable`; expired or reused enrolment code; non-operator enrols; `jobflow_app` writes `platform_operators`; CLI with no `APP_ENV` or a non-operator `--as` | All refused; no row changes; each grant, revoke and code issue is audited | Task T26 (#230); threat T21 |
| Operator session calls company APIs and pages; inspect operator responses; cross-origin operator POST; extend a demo or unknown company | No company data or membership; exact projection key sets; origin refused; error with no change | Task T26 (#230); threat T21 |
| Extension request by each non-owner role, another company's owner, demo and `unrestricted` companies; over the 3-per-7-days and post-decline limits | 403 or 429 with `retryAfterSeconds`; one pending request under concurrency; works only while the company is a trial | Task T27 (#231); threats T20, T21 |
| Request message and company name holding HTML or script, shown in the operator email and pages; two concurrent decisions; `days` outside 1–365; decline with no reason | Text is inert; second decision gives 409 with no change; validation errors make no change; owner sees the "JobFlow operator" label only | Task T27 (#231); threat T21 |
| Outside the required set, for threats T18, T19 and T22: spoofed headers sent straight to the origin; two-user edge-cache check; SVG, renamed HTML, polyglot, trailing data, oversized and bomb-dimension logos | Headers not trusted; no `cf-cache-status: HIT`; files refused with nothing left in store or database; rendering stays within limits | Tasks T9 (#213), T23 (#227), T25 (#229) |

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
- Design review evidence: the root architect/QA reviewer inspected all 13 threats, boundaries, negative-test cases
  and #70/#71 ownership against product rules, with no blocking findings. Implementation tests and controls still
  require QA/code/security review as they land. Before pilot, #61 refreshes it against actual routes, dependencies, hosting and residual findings. No open
  Critical/High findings may remain; #67 separately validates GST outputs. Owner checkpoints remain in force.

### M6 residual risks

Status words below are as of `main` at 85ba5b8. A bare ID in brackets after a heading is a threat; "task Tn" is an
implementation task.

- **A write that bypasses `withAudit` (T20, ADR 0004 D4).** The database guard is a commit-time trigger on
  `audit_events`, so a write with no audit event isn't caught by the database layer and relies on the route guard and
  the "every mutation is audited" review rule. Task T18's static check would reduce this; it isn't in the ADR yet.
- **Exempt transactions (T20).** The trigger checks each audit row, so an exempt transaction admits one allowed audited
  action plus any unaudited write. Any code using the runtime role can declare a key, so the exemption guards against
  mistakes, not against code that is already compromised.
- **Trial columns, export audit and route policy (T14, T20).** `jobflow_app` can update `companies`, and `access_mode`
  defaults to `unrestricted`, so a mass-assignment bug or an onboarding path that omits the mode gives free use for
  life. The export audit stores raw query parameters, so a read-only tenant can store free text and keep an unattached
  upload by naming it. Route-policy tests have known gaps. All are tracked in #260, which isn't done.
- **Environment identity (launch gate).** Demo sign-in refusal and the design-preview block (on `main`), the sign-up
  legal gate, Turnstile enforcement and the reserved-TLD verification exemption (#249) and operator MFA (design) treat a
  host as production only when `APP_ENV` is exactly `production` (or is unset with `NODE_ENV=production`). Any other
  value, such as `prod` or `staging`, leaves them open on a public host: sign-up runs on placeholder terms, Turnstile is
  skipped when no secret is set, and without SMTP settings emailed links go to the console log. Demo seeding is stricter
  and refuses either variable. **Launch-gate control:** the task T32 (#236) checklist must confirm `APP_ENV=production`,
  the Turnstile secret and SMTP settings on the public host before launch. The item is on #236. Any public non-production host needs its own access restriction.
- **Client IP (T18).** The fix depends on deployment settings: if `CLIENT_IP_HEADER` is unset behind a tunnel, or the
  origin isn't bound to loopback, throttle keys are client-controlled. A missing or invalid header falls into one shared
  `unknown` sign-up bucket, so a misconfiguration can also lock everyone out. Full IPv6 addresses are the key until
  #168, so one /64 gets many keys. Customers behind one carrier NAT share a limit.
- **Email starvation (T16).** Zoho limits sending per rolling hour, and bursts from any source can use up that limit.
  Until #266 merges, verification and reset email can be delayed or starved, and a reset link lasts only 1 hour; on
  `main`, a throttling reply also counts towards the 8 attempts, after which the row is marked `failed`. #266, open, adds
  pacing at 40 per hour counted by attempts, account-first ordering, a durable provider pause and 5.1.8 block handling.
  By owner decision (5 November), it marks an email `failed` after 5 throttling or block replies, so a long Zoho block
  can still lose queued email until a manual resend exists (#270). Zoho has no signed bounce webhook, so suppression stays manual.
- **Trial restarts and automated sign-up (T14).** A new mailbox gives a new trial. Plus-addressing, disposable domains
  and a repeated ABN aren't blocked, and flagging duplicates is listed as Later in the requirements. Turnstile raises
  cost but doesn't stop paid solvers. Turnstile failing closed means a Cloudflare outage stops sign-up. The
  breached-password check fails open.
- **Enumeration outside sign-up (T15).** `POST /api/invitations/accept` gives a caller who hasn't proved control of the
  address the same answer for an existing and a new account, and leaves the same company data behind: the invitation stays
  pending, with no membership or company audit event, until a signed-in holder of a confirmed mailbox accepts it (#263). The
  account work runs after the response. A signed-out accept takes no password: a new account gets an unknown one, and only
  the mailbox holder sets the real one, from an emailed link that also confirms the address. A token holder can use up the
  address on an account nobody can yet sign in to; the emailed link or `/forgot-password` recovers it.
- **Operator TOTP limits (T21).** In production an operator's session must itself have passed TOTP (`auth_sessions.mfa_verified_at`), so a password-only session from before enrolment never qualifies. Two library limits remain: Better Auth accepts codes within ±30 seconds and keeps no last-used code, so a relayed code works for about 90 seconds (Cloudflare Access reduces this), and the TOTP secret and backup codes are encrypted with `BETTER_AUTH_SECRET`, not hashed.
- **Scanners and account pre-registration (T17).** The fragment stops scanners that only fetch a URL. `/verify-email`
  spends the token only when "Confirm my email" is pressed (#249), so only a scanner that also clicks could verify the
  address. If an attacker signed up with that address, they would then hold a verified account for it. This is uncertain: no
  specific scanner has been tested. A password reset removes the attacker's access. Whoever holds a live link in a mailbox still holds the token, and Cloudflare (TLS termination) and Zoho can
  see tokens in transit.
- **Better Auth surface (T17).** Whether `/update-user`, change-email and delete-user are limited to name and image at
  runtime on the pinned version isn't confirmed (#260).
- **Edge settings (T18, T19, T21).** Cache rules, feature toggles and Access policy live in Cloudflare, not in code, so
  they can drift after the staging check. Access is enforced at the edge and the design doesn't validate its token at
  the origin, so a request reaching the origin directly relies on the app's own checks alone.
- **Operator (T21).** Shell access on the host, with migration credentials, is above every application control. The
  CLI's `--by` value is self-declared, so audit attribution there is only as good as host access logs. Production MFA
  has the same `APP_ENV` dependency as above. Open PR #254 proposes a separate `/admin-console`, with its own username,
  password and signed cookie, that can extend trials and assign unrestricted access. It lacks the two-key check and TOTP
  of ADR 0004 D5 and returns 401 rather than 404 once configured. It needs a recorded decision and Cloudflare Access
  before it can ship.
- **Malicious logo (T22).** Logo upload (#227) isn't built, and every control in T22 is a requirement until it is.
  Requirement S6 says "re-encoded or validated", and the contracts choose validation with metadata stripping and no
  re-encoding, so image data bytes stay attacker-chosen. Data after a JPEG's end marker must also be dropped, which the
  contracts don't state. Decoder memory use in `pdf-lib` for a hostile PNG hasn't been measured (uncertain). `main` has
  no malware scanning: #261 for #136 is open, and it scans in the documents upload handler, so the logo route must call
  the same scanner, which task T23 doesn't yet require.
