# ADR 0004: Public sign-up, company trial access and the platform operator

Status: proposed for M6 (E2). Date: 2 November 2026. Amends [ADR 0003](0003-authentication.md):
replaces its "No public sign-up" decision and its "password-reset email remains unimplemented" consequence.
Requirements: [public-signup-trial.md](../requirements/public-signup-trial.md) (S1–S14, E1–E5).
Contracts: [architecture/public-signup-trial.md](../architecture/public-signup-trial.md).

## Context

JobFlow goes public at `https://jobflow.shivomsangha.com` behind Cloudflare. Anyone can sign up, verify their email,
create one company and use it for a 30-day trial. After that the company is read-only until a platform operator
extends it. The owner's decisions are fixed in the requirements. Six things need an architectural decision:

1. How sign-up, verification and reset use Better Auth.
2. How trial and access state is stored and computed.
3. Where read-only is enforced so that no write path is missed.
4. What a platform operator is, how the role is granted (AQ2), and whether MFA is required (AQ1).
5. How audit records non-member actors, because `audit_events.created_by` is a membership FK today.
6. Email delivery, scheduling, Turnstile, the client IP and caching behind Cloudflare.

Existing patterns are reused where they fit: `withPolicy`, `withAudit`, the database rate-limit table, SHA-256 token
digests (invitations, #27), the `document_delete_retries` outbox (#170), tsx CLIs run by systemd timers
(`documents:cleanup`, backups), and `APP_ENV` for environment identity.

## Decisions

### D1. Account flows: JobFlow handlers on Better Auth primitives

**Options.**

- **(a) Better Auth's built-in flows.** These are `/sign-up/email` with `onExistingUserSignUp`, `emailVerification`
  and `requestPasswordReset`, plus the `captcha` and `haveibeenpwned` plugins.
- **(b) JobFlow route handlers.** These use Better Auth for password hashing, sessions, sign-in, rate-limit storage
  and the TOTP plugin.

**Decision: (b).** Option (a) can't meet the requirements, for these reasons:

- Better Auth 1.7's email-verification token is a stateless JWT. It can't be revoked when the user resends (S3 AC5),
  and it isn't stored as a digest (S3 AC1).
- The reset token travels in the URL path and then in a redirect query string. That puts it in nginx and Cloudflare
  logs.
- Requesting a new reset link doesn't invalidate the earlier ones (S4 AC2).
- `/sign-up/email` can't record terms acceptance, the production reserved-TLD guard or per-account throttles in the
  same transaction.
- The plugins only hook Better Auth's own endpoints.

`disableSignUp: true` stays on. Better Auth's reset and verification endpoints stay disabled because no
`sendResetPassword` or `sendVerificationEmail` is configured. A test asserts this.

- **Tokens.** Verification tokens last 24 h and reset tokens 1 h. Each is 256-bit random, and only its SHA-256 digest
  is stored in `account_tokens`. A token is single-use, and issuing a new one supersedes the user's live tokens of the
  same purpose.
- **Links.** Links carry the token in the URL **fragment** (`/verify-email#token=…`, `/reset-password#token=…`), the
  same pattern as `/invite#…`. The page POSTs the token, so it never reaches access logs, the `Referer` header or
  link-scanner GETs. These pages send `Referrer-Policy: no-referrer`.
- **Sign-up.**
  - The sign-up handler hashes the password and writes an outbox email in **both** cases, new email and existing
    email. That keeps the timing alike. An existing account is never changed (S2 AC4).
  - A unique-violation race resolves to the "account exists" path (S2 AC5).
  - `SIGNUP_ENABLED` (default `true` outside production) is a kill switch.
- **Breached passwords.** The check is a k-anonymity range lookup: the first 5 hex characters of the SHA-1 go to
  `api.pwnedpasswords.com/range/` with `Add-Padding`, with a 2 s timeout. It **fails open** and logs
  `password_breach_check.unavailable`. A bundled list was rejected: it's hundreds of MB and goes stale.
- **Password reset completion.** One transaction does all of the following:
  - replaces the credential hash, using Better Auth's `hashPassword`;
  - deletes **all** of the user's `auth_sessions`;
  - sets `email_verified`;
  - consumes the token;
  - enqueues the "password changed" email.
- **Verified sessions.** `resolveActor()` gains the status `unverified`, checked before memberships. The exception is
  demo and test identities on reserved TLDs (`.test`, `.example`, `.invalid`, `.localhost`) outside production: they
  can't receive email, and production sign-up refuses those domains.
  - **Invited users are not auto-verified.** Invitation links are copied and shared by the owner (ADR 0003), not
    emailed, so accepting one doesn't prove control of the address. Existing members verify on their next sign-in
    with the emailed link, which works now that Zoho SMTP is live (D7). Revisit if invitations start being emailed.
  - Pages redirect to `/verify-email/pending`.
  - APIs return 403 `email_unverified`.
  - Accounts that existed before M6 and are unverified must verify (S3 AC6). This forces a **deploy-order rule**:
    the email provider must work in an environment before this gate ships there.

### D2. Request wrappers: every route declares one of four boundaries

`tests/unit/route-policy.test.ts` is extended so that every `route.ts` method uses exactly one of these wrappers.

| Wrapper | Who | Guards |
|---|---|---|
| `withPolicy(permission, handler, opts)` | Active company member with the permission (unchanged) | Origin, body limit, verified email, **read-only guard (D4)** |
| `withSession(handler, opts)` | Any signed-in user. `allowUnverified` only for resend and sign-out | Origin, body limit, session. No company context |
| `withPublic(handler, { reason, bodyLimit, throttle, turnstile })` | Anyone | Origin, body limit (4 KiB), IP throttle, optional Turnstile |
| `withOperator(handler)` | Platform operator (D5) | Origin, body limit, operator check. **Every failure returns 404** |

Public and operator routes are listed in the test with a reason, as `PUBLIC_ROUTES` is today. A route under
`app/api/operator/**` must use `withOperator`, and no other route may.

### D3. Company access state: stored facts, derived phase

These are stored on `companies` (details in the contracts doc):

- `access_mode` (`unrestricted | trial`);
- `trial_started_at`;
- `trial_last_day` (a Sydney `date`);
- `read_only_from` (a UTC instant);
- `trial_extension_count`.

`read_only_from` is set **by a database trigger**: `((trial_last_day + 1)::timestamp AT TIME ZONE 'Australia/Sydney')`.
That gives the app and SQL one definition. A CHECK requires all three trial fields when `access_mode = 'trial'`, and
requires `is_demo` companies to be `unrestricted`.

"Read-only", "warning" and "extended" are **derived, never stored**:

- Phase: `normal` (N ≥ 8), `warning` (2–7), `critical` (1), `expired` (N ≤ 0).
- N = `trial_last_day − sydneyDate(now) + 1`.
- Read-only: `access_mode = 'trial' AND read_only_from <= now()`.
- Extended: `trial_extension_count > 0`.

No timer flips state, so a scheduler and a request can't race over it. An extension only moves `trial_last_day`
forward.

- **Pure functions.** `trialWindow(start)`, `sydneyDate(instant)` and `trialStatus(lastDay, now)` live in
  `packages/domain/src/trial.ts`, under the 100 % coverage gate. Tests cover Sydney midnight and both DST
  transitions, and SQL/TS parity.
- **Trial start.** `trial_started_at` is the company creation instant. The last day is
  `sydneyDate(start) + 29 days`.
- **Request time.** `resolveActor()` loads the active membership together with the company's `is_demo`, `access_mode`,
  `trial_last_day` and `read_only_from <= now()`, computed in the **same query** using database time. That meets
  "one indexed lookup", and the banner and the guard agree.
- **S13.** A migration sets every existing company to `unrestricted`, demo companies included (demo stays exempt). It
  writes one `system` audit event per company. Companies created by onboarding start as `trial`.

### D4. Read-only enforcement: route guard plus a commit-time database guard

Enforcement has two layers, and the database layer is authoritative.

1. **Route guard (fast, clear errors).**
   - `withPolicy` refuses every unsafe method (POST/PUT/PATCH/DELETE) for a read-only company with
     `403 { code: "company_read_only" }`. The only exception is a route registered in `READ_ONLY_ALLOWED`
     (`apps/web/src/server/authz/read-only.ts`, `"METHOD /api/path" → reason`).
   - Server actions call `requireWritableActor()`.
   - Safe methods are never blocked.
2. **Database guard (authoritative, uses database time at commit).**
   - A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `audit_events` runs
     `jobflow_assert_company_writable()` **at commit**.
   - If the company is `trial` and `read_only_from <= clock_timestamp()`, it raises SQLSTATE `55000` with
     `jobflow_company_read_only`, unless the transaction declared an exemption.
   - Every company business write already goes through `withAudit`, which refuses a transaction with no audit event
     (T06), so every business write passes this trigger.
   - A write that started before expiry and commits after it is rolled back (S9 AC4).
   - `withPolicy` maps the error to 403 `company_read_only`, the same way `isLockedPeriodError` maps 409 today.
   - **Exemptions.**
     - `withAudit(db, work, { readOnlyExemption })` runs `set_config('jobflow.read_only_exemption', key, true)`.
     - The trigger accepts only keys in the SQL map `jobflow_read_only_exemptions()`, which mirrors the TypeScript
       `READ_ONLY_ALLOWED` table **key → allowed audit actions**. It checks the audit row's `action` against the
       actions allowed for the declared key, not just that the key exists, so a transaction declaring `export` can't
       also commit `invoice.issued`. A parity test checks the two maps match.
     - Raw audit inserts (document cleanup) use the same helper.

| Exemption key | Allowed action (S9 AC2, S12 AC2) |
|---|---|
| `export` | `company.exported`, `report.exported`, `report.export_refused` |
| `record_rendering` | `invoice.pdf_stored` for an already-issued invoice or credit note |
| `access_removal` | Membership deactivation only (no role change), `invitation.revoked` |
| `invitation_pre_expiry` | `invitation.accepted` when the invitation was created before `read_only_from` |
| `trial_extension_request` | Owner submits a request (S14) |
| `operator` | Operator trial or access changes and request decisions (D5) |
| `housekeeping` | `document.unattached_deleted` (scheduled cleanup) |

**Route allowlist (initial).**

- `POST /api/documents/[id]/link`: download link only.
- `POST /api/invoices/[id]/pdf`: stores or links an issued document's PDF, using the `record_rendering` key.
- `GET`-based exports need no entry. They're safe methods, and the database guard covers them through the `export`
  key.
- `PATCH /api/users/[id]`: the handler passes `access_removal` only for a pure deactivation. A role change still fails
  at the database.
- `DELETE /api/users/invitations/[id]`.
- `POST /api/company/trial/extension-requests`.
- `POST /api/invitations/accept` uses `withPublic`, and it enforces the pre-expiry rule itself.

**Tests (S9 AC1).**

- A unit test enumerates every unsafe `withPolicy` route from `tests/helpers/route-matrix.ts`. It fails when a route
  is neither guarded nor in `READ_ONLY_ALLOWED` with a reason.
- An integration test calls **every** unsafe route as an owner of an expired company and asserts
  `403 company_read_only`, apart from the allowlist.
- A database test proves that a transaction committing after `read_only_from` rolls back, and that each exemption key
  admits only its own actions.
- **Residual risk.** A future write that bypasses `withAudit` would skip the database layer. The route guard and the
  existing "every mutation is audited" review rule mitigate this.

### D5. Platform operator (AQ1, AQ2)

- **Role.** The role is platform-level. It's **not** in `MembershipRole` or `packages/authz` role grants, and it never
  grants company app access.
- **Operator check.** A user is an operator only when **both** of these hold:
  - an active row in `platform_operators` (`revoked_at IS NULL`);
  - the user ID is listed in the `JOBFLOW_OPERATOR_USER_IDS` environment allowlist.

  Two keys mean a leaked database write or a mis-set environment variable alone can't create an operator.
- **AQ2, granting and revoking.**
  - Only the server CLI `pnpm operator grant|revoke|list` changes the role. It runs on the host in the maintenance
    container with the migration database credentials, so there's no HTTP path.
  - `grant` requires an existing user with a verified email and a `--reason`.
  - Each grant and revoke writes a `platform_audit_events` row (`actor_kind = 'system'`, the OS user from `--by`).
  - Revocation takes effect on the next request. Removing the ID from the environment and restarting is the second
    off switch.
- **AQ1, MFA: required in production.**
  - TOTP comes from Better Auth's `twoFactor` plugin. Its `two_factor` table and `users.two_factor_enabled` field are
    an addition to ADR 0003's tables. Trust-device is disabled.
  - In production, `withOperator` and `requireOperator()` also need `two_factor_enabled = true`. Better Auth only
    creates a session for such a user after the TOTP step.
  - An operator without TOTP reaches only `/operator/mfa`, the enrolment page. Every other operator page and API
    returns 404.
  - Until enrolment, the CLI is the production path, as the requirements recommend.
  - A Better Auth `hooks.before` refuses `/two-factor/*` enrolment for non-operators. MFA for company users stays
    with #61.
- **Boundary.**
  - Operator routes return only the least-privilege projection in S11 AC2.
  - Operator actions go through one service, `trialAccess`, which validates, locks the company row, updates it, closes
    a pending request, writes the audit event and enqueues emails in one transaction.
  - The CLI calls the same service with `--as <operatorUserId>`, which must pass the same two-key check. The production
    MFA rule doesn't apply to the CLI, because shell access is the stronger credential.
- **Cloudflare Access (owner decision, 3 Nov 2026): required.** `/operator*`, `/api/operator/*` and
  `/api/auth/two-factor/*` sit behind a Cloudflare Access policy for the operator's email. #213 includes it in its
  acceptance criteria.
- **Enrolment code.** An operator without TOTP has a password-only session, so whoever holds the password could enrol
  their own authenticator first. Enrolment therefore needs a one-time code from the host:
  `pnpm operator enrol-code --user <id>` (10 minutes, single use, only the digest stored in `account_tokens` with a new
  purpose `operator_enrolment`). Better Auth's `/two-factor/enable` is refused without a valid code.

### D6. Audit actors and the user-level security log

- **Company audit trail.** `audit_events` gains:
  - `actor_kind` (`member | operator | system`, default `member`);
  - a nullable `operator_user_id`, an FK to `platform_operators`.

  `created_by` becomes nullable. A CHECK ties the kinds together:
  - a member has `created_by` and no operator;
  - an operator has `operator_user_id` and no `created_by`;
  - system has neither.

  The composite membership FK still applies when `created_by` is set. `AuditEventInput` takes
  `actor: { kind: "member", userId } | { kind: "operator", operatorUserId } | { kind: "system" }`, and the existing
  `actorUserId` stays as shorthand for a member.
- **Owner-facing labels.** Owners see "JobFlow operator" and "JobFlow". The operator's identity stays in the stored
  row for the export and the operator, but the owner UI shows the label only.
- **Events with no company.** Sign-up, verification, reset requested or completed, throttling and operator
  grant/revoke go to the append-only table `platform_audit_events`:
  - `actor_kind`;
  - a nullable `user_id`;
  - `action`;
  - redacted `metadata`;
  - `request_id`;
  - `created_at`.

  It holds no email, IP or token. For an unknown email, the event has no user ID. Retention follows #62.

### D7. Email: transactional outbox, provider port and scheduled jobs

- **Outbox.**
  - Every email is a row in `email_outbox`, written **in the same transaction** as the change that causes it.
  - The rendered payload, which holds the recipient and any link, is encrypted with AES-256-GCM. The key comes from
    HKDF of `EMAIL_OUTBOX_KEY`. The payload is nulled once it's sent, cancelled or expired.
  - A unique `dedupe_key` makes enqueueing idempotent.
- **Dispatch.**
  - After commit, the request schedules `dispatchOutbox()` with Next's `after()`, as `pdf-store` does. That meets
    "within 60 s".
  - A sweep (`pnpm jobs:run`) claims due rows with `FOR UPDATE SKIP LOCKED`. It retries with backoff up to 8 attempts,
    then marks the row `failed`. Logs carry the row ID and the error class, never the address.
- **Provider port.** The `EmailTransport` interface has `send(message) → { providerMessageId }`.
  - `MemoryTransport` serves tests. The e2e harness reads verification links from it through a test-only hook that is
    disabled in production.
  - `ConsoleTransport` serves development and prints the link only, never in production.
  - **Real adapter: Zoho Mail SMTP** (owner decision, 3 November 2026). The domain already uses Zoho's Australian
    data centre (MX `mx.zoho.com.au`, SPF `include:zohomail.com.au`, DKIM selector `zmail`). `SmtpTransport` sends
    as `admin@shivomsangha.com` through `smtppro.zoho.com.au:465` with implicit TLS, authenticated with a Zoho
    **app-specific password**, never the account password. Settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
    `SMTP_USER` and `SMTP_PASSWORD`, all from the environment only. Certificate verification stays on.
  - Zoho SMTP has no signed bounce or complaint webhook. Bounces arrive as mail in the `admin@` mailbox, so the
    suppression list is fed manually or by a later IMAP reader. Zoho also caps sending per user per day; the
    dispatcher must treat throttling errors (SMTP 4xx/554 rate replies) as retryable and alert when limits are hit.
    Move to a transactional provider if volume outgrows the mailbox limits.
  - Bounces and complaints add the address digest to `email_suppressions`, and suppressed addresses aren't sent to.
    The digest is HMAC-SHA-256 keyed by HKDF(`EMAIL_OUTBOX_KEY`, info `address-digest-v1`), separate from the payload
    key. Rotating `EMAIL_OUTBOX_KEY` invalidates existing digests: suppressions are dropped on rotation (or re-added
    from the bounce mailbox).
- **Addresses.** Sender, reply-to and support default to `admin@shivomsangha.com` through `EMAIL_FROM`,
  `EMAIL_REPLY_TO` and `SUPPORT_EMAIL`. `OPERATOR_NOTIFY_EMAIL` is the operator's address and has no default
  (to be confirmed by the owner: `admin@shivomsangha.com` or `jobflow@shivomsangha.com`).
  `EMAIL_FROM` must equal `SMTP_USER` (or an alias verified in Zoho), or Zoho rejects the message.
- **Content.** Templates are plain text plus minimal escaped HTML.
  - Emails to unverified addresses contain no user-entered text (S2 AC9).
  - System emails are JobFlow-branded, not company-branded.
- **Scheduler (E4).**
  - One idempotent CLI, `pnpm jobs:run`, runs trial reminders and then the outbox sweep. It holds a
    `pg_try_advisory_lock`, so overlapping runs or hosts skip safely.
  - A systemd timer runs it every 5 minutes, using the same maintenance-container pattern as `documents:cleanup`.
  - Redis and in-process cron were rejected. ARCHITECTURE.md says to start without Redis, and in-process cron
    duplicates work across instances.
- **Reminders.**
  - For each trial company and `trial_last_day`, the job picks the latest threshold that applies (7, 3, 1 or ended).
  - It inserts it into `trial_notifications`, with a unique key on company, last day and threshold, unless that
    threshold or a later one already exists.
  - It then enqueues one email for each active owner with a verified email.
  - An extension changes `trial_last_day`, which re-arms every threshold (S10 AC4).

### D8. Cloudflare edge

- **Topology: Cloudflare Tunnel.**
  - A `cloudflared` container on the internal Compose network connects to nginx.
  - The host publishes **no** inbound 80/443, and Certbot is dropped for this host. Cloudflare terminates TLS.
  - With a proxied DNS record instead, the origin would need to be firewalled to Cloudflare's IP ranges and use
    Authenticated Origin Pulls. The tunnel is simpler and closes the origin.
- **Client IP.**
  - nginx sets `real_ip_header CF-Connecting-IP`, and `set_real_ip_from` is limited to the `cloudflared` container
    subnet. It keeps **overwriting** `X-Forwarded-For` with `$remote_addr`.
  - `clientIp()` and nginx `limit_req` therefore see the real client without any app change.
  - The app never reads `CF-Connecting-IP` itself, so only one hop is trusted.
  - Per-/64 IPv6 keys stay a #168 item.
- **Caching.**
  - One Cache Rule bypasses the cache for everything on the hostname except `/_next/static/*`.
  - Every dynamic page and API already sends `private, no-store`. The app shell layout must keep that.
  - These features are off, because they inject scripts (which breaks CSP) or serve stale pages: Rocket Loader, Email
    Obfuscation, Auto Minify, Always Online, Mirage and Zaraz.
  - A staging check uses two browser contexts to prove that no user page is served from the cache
    (`cf-cache-status` isn't `HIT`).
- **HSTS.** The app already sends HSTS when `BETTER_AUTH_URL` is `https`. Edge HSTS is enabled with the same
  max-age. `BETTER_AUTH_URL=https://jobflow.shivomsangha.com`.
- **Turnstile.**
  - Server-side `siteverify` checks `success`, `hostname` and `action` (`signup`, `forgot`, `resend`).
  - It **fails closed**: a missing, invalid or unavailable verification returns a generic 400 and creates nothing.
  - CSP gains `https://challenges.cloudflare.com` in `script-src` and `frame-src`, **only** on the three pages that
    render the widget.
  - Non-production uses Cloudflare's documented test keys. `TURNSTILE_SECRET_KEY` is server-only.

### D9. Terms launch gate (E5)

- `apps/web/src/content/legal/versions.ts` exports `TERMS_VERSION` and `PRIVACY_VERSION`, starting at
  `placeholder-2026-11`.
- Sign-up records both versions in `terms_acceptances`.
- In production, the sign-up handler refuses (503 `signup_unavailable`) while either version starts with
  `placeholder-`.
- `scripts/ci/check-legal-versions.mjs` fails the production release check under the same condition.

## Consequences

- ADR 0003's "No public sign-up" and its reset consequence are superseded here. Its other decisions stand: sessions,
  cookies, CSRF, the sign-in throttle and actor resolution.
- New tables and columns are summarised in the contracts doc. All of them are additive, apart from
  `audit_events.created_by` becoming nullable. That change is backward-compatible for old code, which always sets it.
- Every new mutating route must state whether it's allowed while read-only. CI fails until it does.
- Operators can't see company data. Support cases that need data still go through the owner (export) or the database
  under the existing restricted-operator rules.
- New external dependencies:
  - the email provider (E1);
  - Turnstile `siteverify`;
  - the Pwned Passwords range API, which fails open.

  Egress from the web container must allow these three.
- These questions are left to the owner: the AQ1 confirmation, the optional Cloudflare Access for `/operator`, the
  operator notification address, the provider choice and cost after E1, and the reviewed legal text.

### Documentation to change after acceptance (not edited in this ADR)

- **`AGENTS.md`**
  - "Roles" line: add that a separate **platform-operator** role exists, which isn't a company role and gives no
    company data access.
  - "Mandatory technical requirements": add that read-only companies are enforced server-side through the central
    guard.
- **`CLAUDE.md`**
  - Non-negotiables: mention the platform-operator boundary and that new mutating routes must declare read-only
    behaviour.
  - Commands table: add `pnpm jobs:run` and `pnpm operator`.
- **`docs/architecture/authorisation.md`**: the four wrappers (D2), the `unverified` resolution, the read-only guard
  and the operator boundary.
- **`docs/architecture/user-access.md`**: "Accounts without any membership can authenticate" now leads to onboarding.
  Deactivation and revocation stay allowed while read-only.
- **`docs/adr/0003-authentication.md` consequences**: rate limiting now relies on nginx trusting `CF-Connecting-IP`
  from the tunnel only.
- **`docs/SECURITY.md` / `docs/security/requirements.md`**: the client-IP rule behind Cloudflare, operator MFA, and
  the email token rules.
- **`docs/DATA_MODEL.md`**: new tables and columns (database tasks).
- **`docs/ops/staging.md` and `deployment.md`**: the tunnel, timers and new secrets.
- **`README.md`**: public sign-up.
