# M6 public sign-up and trial: implementation tasks

This breaks [ADR 0004](../adr/0004-public-signup-and-trial.md) and the
[contracts](public-signup-trial.md) into issue-ready tasks, from the
[requirements](../requirements/public-signup-trial.md). Every task belongs to milestone **M6 Public launch** and is
labelled `agent:<owner>`, `type:<type>`, `priority:<p>` and its area labels. One task is one PR. Tasks are listed in
dependency order.

Every task meets these acceptance criteria (shared ACs):

- (a) CI is green: typecheck, lint, unit, integration, e2e when the UI changes, coverage for `packages/domain`.
- (b) No email, ABN, phone or token appears in logs, audit metadata or test snapshots.
- (c) New routes appear in `docs/security/route-matrix.md` and `route-policy.test.ts`.

## Summary

| ID | Title | Agent | Pri | Depends on |
|---|---|---|---|---|
| T1 | ADR 0004 and contracts (this PR) | architect | p0 | — |
| T2 | Spike: transactional email provider | research-dev | p0 | — |
| T3 | Threat model: public sign-up, email, trial and operator | security-engineer | p0 | T1 |
| T4 | UX flows and screens | ui-ux-designer | p0 | T1 |
| T5 | Domain: Sydney-day trial clock | backend-engineer | p0 | T1 |
| T6 | Schema: accounts, outbox, operators, actor-aware audit | database-engineer | p0 | T1 |
| T7 | Schema: company access, trial, profile, logo, quote snapshot, write-guard trigger, S13 backfill | database-engineer | p0 | T6 |
| T8 | Terms and privacy placeholders and production launch gate | engineer | p0 | T1 |
| T9 | Cloudflare Tunnel, trusted client IP, cache rules, HSTS, Turnstile keys | devops-engineer | p0 | T1 |
| T10 | Email outbox, transport port and dispatcher | backend-engineer | p0 | T6 |
| T11 | Email provider adapter and bounce/complaint webhook | backend-engineer | p0 | T2, T10 |
| T12 | Sender DNS (SPF/DKIM/DMARC) and email secrets per environment | devops-engineer | p0 | T2, T9 |
| T13 | Sign-up API | backend-engineer | p0 | T6, T8, T10 |
| T14 | Email verification, resend and verified-session gating | backend-engineer | p0 | T13 |
| T15 | Password reset by email | backend-engineer | p0 | T14 |
| T16 | Onboarding API and company selection | backend-engineer | p0 | T5, T7, T14 |
| T17 | Trial access in actor resolution and trial status API | backend-engineer | p0 | T5, T7 |
| T18 | Central read-only write guard | backend-engineer | p0 | T7, T17 |
| T19 | Route gating, public allowlist, safe return path, company chooser | frontend-engineer | p0 | T4, T14, T16 |
| T20 | Sign-up, verify, resend, forgot and reset pages | frontend-engineer | p0 | T4, T13, T14, T15 |
| T21 | Onboarding step 1, setup checklist and "Create a company" | frontend-engineer | p0 | T4, T16, T19 |
| T22 | Trial indicator, banners and read-only UI states | frontend-engineer | p0 | T4, T17, T18 |
| T23 | Company profile extras and logo API | backend-engineer | p1 | T7 |
| T24 | Company details UI: optional onboarding steps, settings, logo | frontend-engineer | p1 | T4, T21, T23 |
| T25 | Supplier snapshot extension and PDF logo | backend-engineer | p1 | T23 |
| T26 | Platform operator role, guard, TOTP and CLI | backend-engineer | p0 | T5, T7, T10, T18 |
| T27 | Trial extension requests and operator decision API | backend-engineer | p0 | T26 |
| T28 | Operator area UI and owner trial settings and request UI | frontend-engineer | p0 | T4, T22, T27 |
| T29 | Trial reminder emails and one-time notices | backend-engineer | p1 | T10, T17, T27 |
| T30 | Scheduled jobs timer (`jobs:run`) | devops-engineer | p1 | T10, T29 |
| T31 | E2E acceptance suite for M6 | qa-engineer | p0 | T19–T22, T24, T28, T29 |
| T32 | Pre-launch security review of M6 | security-engineer | p0 | T3, T9, T11–T18, T23, T26, T27 |
| T33 | Docs: README, user guide, operator runbook, rule-file wording | tech-writer | p1 | T9, T12, T26, T30 |

The critical path to a public launch is T6 → T10 → T13 → T14 → T16 → T19/T21 and T7 → T17 → T18 → T26 → T27 → T28,
then T31 and T32. Separately, T2 → T11/T12 must finish before T14 is deployed to any environment with real users. That's
the ADR 0004 D1 deploy-order rule.

## Tasks

### T1. [M6] ADR 0004: public sign-up, trial access and platform operator

- **Agent:** architect · **Type:** docs · **Priority:** p0 · **Areas:** documentation, security
- **Depends on:** none · **Covers:** E2, AQ1, AQ2 · **Status:** done in this PR
- **Acceptance criteria:**
  - ADR 0004 records D1–D9. ADR 0003's status line references it.
  - The contracts doc defines the schema, APIs, route map, sequence, snapshot, logo and operator area.
  - The task list is issue-ready.
  - The rule-file wording changes needed after acceptance are listed in the ADR.

### T2. [M6] Spike: transactional email provider

- **Agent:** research-dev · **Type:** spike · **Priority:** p0 · **Areas:** backend, infra, documentation
- **Depends on:** none · **Covers:** E1
- **Acceptance criteria:**
  - `docs/research/email-provider.md` compares at least 3 providers, for example Amazon SES ap-southeast-2, Postmark
    and Resend, on:
    - data location and processing terms (Australian, or GDPR-grade);
    - cost at 1k, 10k and 100k emails a month;
    - deliverability features;
    - bounce and complaint webhooks and how they're signed;
    - API key scoping.
  - It recommends one provider and gives the exact DNS records needed for `admin@shivomsangha.com` (SPF include,
    DKIM selectors, DMARC policy starting at `p=none` with rua).
  - It confirms that internationalised address (SMTPUTF8) support exists, or doesn't.
  - It sketches the adapter for the `EmailTransport` port (ADR 0004 D7) without adding a dependency.
  - It lists the owner actions: account, domain verification, billing.

### T3. [M6] Threat model: public sign-up, email, trial and operator

- **Agent:** security-engineer · **Type:** docs · **Priority:** p0 · **Areas:** security, documentation
- **Depends on:** T1 · **Covers:** NFR security
- **Acceptance criteria:**
  - New STRIDE rows in `docs/security/threat-model.md` cover:
    - mass sign-up and trial restarting;
    - account and email enumeration;
    - email relay and spam abuse;
    - token theft, replay and leakage (logs, Referer, scanners);
    - client-IP spoofing behind Cloudflare;
    - cache poisoning or leakage at the edge;
    - read-only bypass;
    - operator account compromise and privilege creep;
    - a malicious logo file.
  - Each row maps to an ADR 0004 control and a task ID.
  - "Required negative tests" lists the tests T13–T18 and T26–T27 must include.
  - Residual risks are named, for example a write path that bypasses `withAudit`.

### T4. [M6] UX: sign-up, verification, reset, onboarding, trial and operator screens

- **Agent:** ui-ux-designer · **Type:** design · **Priority:** p0 · **Areas:** design, frontend
- **Depends on:** T1 · **Covers:** S1–S6, S8, S9 AC5, S10 AC3, S11, S14
- **Acceptance criteria:**
  - `docs/design/signup-trial.md` gives a flow diagram and a screen spec for:
    - sign-in (with "Create an account");
    - sign-up and check-email;
    - verify, pending verification and resend;
    - forgot and reset;
    - onboarding step 1 and the optional steps;
    - the setup checklist;
    - the company chooser;
    - trial settings and the request extension form;
    - the operator list, detail and MFA pages.
  - Each screen has copy, states (empty, error, loading, throttled with retry time, success) and field-level errors.
  - It specifies the trial indicator and banner for every phase and role (S8 AC1–AC4), plus the read-only control
    pattern (S9 AC5).
  - It meets WCAG 2.2 AA: keyboard order, focus, labelled errors, 320 px reflow, light and dark contrast, a
    non-colour state cue, and the Turnstile accessible fallback.

### T5. [M6] Domain: Sydney-day trial clock

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, testing
- **Depends on:** T1 · **Covers:** glossary, S8 AC5
- **Acceptance criteria:**
  - `packages/domain/src/trial.ts` exports:
    - `sydneyDate(instant)`;
    - `trialWindow(start) → { lastDay, readOnlyFrom }`;
    - `trialStatus(lastDay, now) → { daysRemaining, phase }`;
    - `extensionLastDay(current, todaySydney, days)`;
    - `validateDirectExtension(current, newLastDay, todaySydney)`.
  - The requirements example holds: created 2 Nov 2026 15:00 Sydney gives a last day of 1 Dec 2026 and read-only from
    2026-12-01T13:00Z.
  - Tests cover creation just before and just after Sydney midnight, a Sydney date that differs from the UTC date, and
    both DST transitions (the first Sunday in October and the first Sunday in April).
  - Phases follow the thresholds N ≥ 8, 2–7, 1 and ≤ 0.
  - Coverage of `packages/domain` stays at 100 %.

### T6. [M6] Schema: account tokens, terms, email outbox, operators and actor-aware audit

- **Agent:** database-engineer · **Type:** feature · **Priority:** p0 · **Areas:** database
- **Depends on:** T1 · **Covers:** S2 AC6, S3, S4, S10, S11 AC5, E2
- **Acceptance criteria:**
  - A migration plus rollback adds:
    - the tables `account_tokens`, `terms_acceptances`, `email_outbox`, `email_suppressions`, `platform_operators`,
      `platform_audit_events` and `two_factor`;
    - `users.two_factor_enabled`;
    - the `audit_events.actor_kind` and `operator_user_id` columns, with `created_by` made nullable.
  - All constraints follow the contracts doc.
  - The audit actor CHECK rejects each invalid combination, and an existing member event still needs its membership
    FK.
  - `packages/database/src/audit.ts` accepts `actor: member | operator | system`. Existing callers compile unchanged.
  - `terms_acceptances` and `platform_audit_events` are append-only: UPDATE and DELETE fail.
  - Runtime-role grants follow the contracts doc. `jobflow_app` can't write `platform_operators`, and a test proves it.
  - `docs/DATA_MODEL.md` and the migration tests (`tenancy-migration`, `database`) are updated.

### T7. [M6] Schema: company access state, trial fields, profile extras, logo, quote snapshot, write guard and S13 backfill

- **Agent:** database-engineer · **Type:** feature · **Priority:** p0 · **Areas:** database, security
- **Depends on:** T6 · **Covers:** S5 AC3, S6, S7 AC1, S9 AC1 and AC4, S13, S14
- **Acceptance criteria:**
  - The `companies` columns and constraints, `document_kind.company_logo`, `quotes.supplier_snapshot`, and the
    `trial_notifications`, `user_notices` and `trial_extension_requests` tables are added as in the contracts doc.
  - A trigger derives `read_only_from` from `trial_last_day` (Sydney). SQL and `packages/domain` `trialWindow` agree
    on the T5 fixtures, including DST.
  - A demo company can't be `trial`. A `trial` company without its dates is refused.
  - The deferred `audit_events_company_writable` trigger rejects a commit after `read_only_from` with
    `jobflow_company_read_only`, unless the audit row's action is one of the actions allowed for the
    transaction's `jobflow.read_only_exemption` key (`jobflow_read_only_exemption_actions`).
    - Tests show that each key admits its own actions, and that a valid key with an unrelated action (for example
      `export` together with `invoice.issued`) is rejected and rolled back.
    - A null, unknown or stale key admits nothing.
    - Tested: a commit after the instant fails, an exempt key passes, and an unknown key fails.
  - **S13:** every existing company is `unrestricted` and gets one `system` audit event `company.access_initialised`.
    A test proves no company is read-only after the migration.
  - `trial_extension_requests` allows one pending request per company (concurrent insert test). Decided rows are
    immutable.
  - The quote freeze trigger also covers `supplier_snapshot`.
  - `docs/DATA_MODEL.md` is updated.

### T8. [M6] Terms and privacy placeholder pages, versions and production launch gate

- **Agent:** engineer · **Type:** feature · **Priority:** p0 · **Areas:** frontend, infra
- **Depends on:** T1 · **Covers:** E5, S2 AC6
- **Acceptance criteria:**
  - Public `/terms` and `/privacy` pages render content from `apps/web/src/content/legal/`. They show the version
    `placeholder-2026-11` and a clear "placeholder, not reviewed" notice.
  - `versions.ts` exports `TERMS_VERSION` and `PRIVACY_VERSION` as the single source.
  - `isSignupOpen(env)` returns false in production while either version starts with `placeholder-`. A unit test
    covers this.
  - `scripts/ci/check-legal-versions.mjs` exits non-zero for `APP_ENV=production` with placeholder versions, and is
    wired into the production release checklist.
  - Both pages are in the S1 public allowlist and pass axe.

### T9. [M6] Cloudflare Tunnel, trusted client IP, cache rules, HSTS and Turnstile keys

- **Agent:** devops-engineer · **Type:** chore · **Priority:** p0 · **Areas:** infra, security
- **Depends on:** T1 · **Covers:** E3, S1 AC8
- **Acceptance criteria:**
  - A `cloudflared` service (pinned by digest, `TUNNEL_TOKEN` from the environment file) connects to nginx on the
    internal network. The production compose publishes no host 80/443.
  - `docs/ops/cloudflare.md` documents the firewall closing inbound traffic.
  - nginx sets `real_ip_header CF-Connecting-IP`, with `set_real_ip_from` limited to the `cloudflared` subnet. It still
    overwrites `X-Forwarded-For`.
    - A test shows that a spoofed `CF-Connecting-IP` or `X-Forwarded-For` sent straight to nginx from another
      container isn't trusted.
    - A test shows that throttles key on the real client IP.
  - The Cloudflare settings are documented as reproducible steps or Terraform:
    - a Cache Rule bypasses everything except `/_next/static/*`;
    - Rocket Loader, Email Obfuscation, Auto Minify, Always Online and Zaraz are off;
    - edge HSTS is on;
    - SSL is Full (strict) or the tunnel is used.
  - `scripts/ops/check-edge-cache.mjs` signs in as two synthetic users in separate contexts on staging. It asserts
    `private, no-store` and that no app page or API returns `cf-cache-status: HIT`, and records the output.
  - The environment examples gain:
    - `BETTER_AUTH_URL=https://jobflow.shivomsangha.com`;
    - `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, with test keys documented for non-production;
    - `JOBFLOW_OPERATOR_USER_IDS`;
    - `EMAIL_OUTBOX_KEY`;
    - `SIGNUP_ENABLED`.
  - **Cloudflare Access is required** (owner decision, 3 November 2026). Its policy allows only the operator's
    identity on `/operator*`, `/api/operator/*` and `/api/auth/two-factor/*`, and excludes `/api/webhooks/*`. A staging
    check shows these paths refuse a request without an Access token, and the webhook path accepts one.
  - It lists the owner actions: create the tunnel, the hostname, the Turnstile site keys and the Cloudflare Access
    application and policy.

### T10. [M6] Email outbox, transport port and dispatcher

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend
- **Depends on:** T6 · **Covers:** S2 AC9, S10 AC2, E4 (part)
- **Acceptance criteria:**
  - `enqueueEmail(tx, { kind, dedupeKey, to, data })` writes an AES-256-GCM encrypted payload in the caller's
    transaction. A duplicate `dedupeKey` is a no-op.
  - `dispatchOutbox()` claims rows with `FOR UPDATE SKIP LOCKED`. It sends through `EmailTransport` and nulls the
    payload on `sent`. It backs off and retries up to 8 attempts, then marks the row `failed`.
    - Tested: two concurrent dispatchers send each row once.
  - Request handlers trigger dispatch with `after()`.
  - `pnpm jobs:run` runs the sweep under `pg_try_advisory_lock`.
  - `MemoryTransport` is for tests and `ConsoleTransport` for development. Production refuses to start without a real
    transport configured.
  - Templates exist for verify, account-exists, reset, password-changed, trial reminder (7, 3, 1, ended),
    trial-extended, request-decided and operator-new-request.
    - Every value is escaped.
    - Templates for unverified recipients contain no user-entered text.
    - The links use `BETTER_AUTH_URL`.
  - Addresses are never logged, and the suppression list is honoured.

### T11. [M6] Email provider adapter and bounce/complaint webhook

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, security
- **Depends on:** T2, T10 · **Covers:** E1
- **Acceptance criteria:**
  - The adapter for the T2-chosen provider implements `EmailTransport`. Its dependency is pinned and licence-checked.
  - `EMAIL_FROM`, `EMAIL_REPLY_TO` and `SUPPORT_EMAIL` default to `admin@shivomsangha.com` (Zoho SMTP, ADR 0004
    D7). `OPERATOR_NOTIFY_EMAIL` is required wherever S14 is enabled (owner confirms the address).
  - `withWebhook` exists (ADR 0004 D2), and `route-policy.test.ts` allows it only under `app/api/webhooks/**`.
  - `POST /api/webhooks/email` uses it, once a provider that signs callbacks is in use (Zoho SMTP has none):
    - It verifies the provider signature over the raw body, with no origin check.
    - It refuses unsigned, stale (±5 min), wrong-topic or replayed events (`email_webhook_events`).
    - It never follows a subscription-confirmation URL.
    - It adds hard bounces and complaints to `email_suppressions` by address HMAC.
    - Tests use a locally generated test certificate or key; nothing calls the provider.
  - Outside production, `EMAIL_RECIPIENT_ALLOWLIST` is required. Other recipients are marked `cancelled` and never
    sent (#239).
  - Provider errors map to retryable or permanent. Tested with a stub server.
  - The API key is read from the environment only and never logged.

### T12. [M6] Sender DNS (SPF/DKIM/DMARC) and email secrets per environment

- **Agent:** devops-engineer · **Type:** chore · **Priority:** p0 · **Areas:** infra
- **Depends on:** T2, T9 · **Covers:** E1, owner decision 8
- **Acceptance criteria:**
  - `docs/ops/email.md` lists the exact Cloudflare DNS records for SPF, DKIM and DMARC that the owner adds, and how to
    check them (`dig`, plus a provider verification screenshot or output).
  - Staging and production environment files gain the provider key, `EMAIL_OUTBOX_KEY`, `EMAIL_EVENTS_TOPIC_ARN`,
    `EMAIL_RECIPIENT_ALLOWLIST` (staging) and the addresses. Nothing is committed.
  - A staging test email to a test inbox passes SPF, DKIM and DMARC alignment, and the headers are recorded.
  - Egress from the web container to the provider, Turnstile and `api.pwnedpasswords.com` is allowed and documented.

### T13. [M6] Sign-up API with Turnstile, throttles, breached-password check and terms acceptance

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, security
- **Depends on:** T6, T8, T10 · **Covers:** S2, S12 AC4
- **Acceptance criteria:**
  - `withPublic` exists and `route-policy.test.ts` enforces the five-wrapper rule (ADR 0004 D2).
  - `POST /api/account/sign-up` validates per S2 AC2 and returns an identical 202 for a new, unverified, verified,
    invited, deactivated or demo email.
    - An existing account is unchanged and gets the "account exists" email.
    - QA measures the median timing difference as below 50 ms over 200 runs.
  - A concurrent same-email race creates exactly 1 user, and both responses are 202.
  - Turnstile is verified server-side (`success`, hostname, action). A missing or failed token creates nothing and
    returns a generic 400. Test keys are used outside production.
  - IP throttle 5/h → 429 with `retryAfterSeconds`.
  - The existing-email path sends at most 1 "account exists" email per hour and 3 per day per address HMAC. Beyond that
    it sends nothing and still returns the identical 202. Tested.
  - The shared email schema refuses a non-ASCII local part with a field message and stores an IDN domain as Punycode
    (#239: SES has no SMTPUTF8). Invitations use the same schema.
  - In production, reserved TLDs (`.test`, `.example`, `.invalid`, `.localhost`) are refused, and placeholder legal
    versions give 503 (T8).
  - The breached-password k-anonymity check rejects a known-breached password. When the service is down (stubbed),
    sign-up succeeds and the event `password_breach_check.unavailable` is logged.
  - A `terms_acceptances` row is written. No company, membership or trial is created. A `platform_audit_events`
    `account.signed_up` event is written without PII.

### T14. [M6] Email verification, resend and verified-session gating

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, security
- **Depends on:** T13 · **Covers:** S3, S1 AC3
- **Acceptance criteria:**
  - The verification token is 256-bit and stored as a SHA-256 digest. It lasts 24 h and is single-use. A newer token
    supersedes older ones.
  - `POST /api/account/verify-email` returns `verified`, or `already-verified` on a second click. An expired,
    consumed, superseded or tampered token returns 400 `token_invalid` and changes nothing.
  - Public resend gives an identical 202 for any address. Signed-in resend is limited to 1/min and 5/day per account,
    plus the IP limit, and returns `retryAfterSeconds`.
  - `resolveActor()` returns `unverified` for unverified users, except non-production demo accounts.
    - `withPolicy` returns 403 `email_unverified`.
    - `withSession` exists with `allowUnverified`.
    - An integration test shows that an unverified pre-existing or invited user can't reach any company API.
  - Accepting an invitation does **not** set `email_verified`, because the link is shared by the owner and isn't
    mailbox proof. Tested.
  - The token never appears in logs, audit or platform events. The verify page sends `Referrer-Policy: no-referrer`.

### T15. [M6] Password reset by email

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, security
- **Depends on:** T14 · **Covers:** S4, S3 AC7
- **Acceptance criteria:**
  - `POST /api/account/password/forgot` always returns an identical 202 with similar timing. Only existing accounts
    (not production demo accounts) get an email.
  - Limits are 3/h per account and 10/h per IP, plus Turnstile. Throttled requests are still 202, send nothing and
    are counted in `platform_audit_events`.
  - The reset token lasts 1 h and is single-use. A new request supersedes the old link.
  - On success, one transaction does all of the following, with an integration test for each:
    - replaces the hash;
    - deletes **all** of the user's sessions;
    - sets `email_verified`;
    - consumes the token;
    - enqueues "password changed".
  - A reset never reactivates a membership or grants company access.
  - Better Auth's own reset and verification endpoints stay disabled, and a test asserts this.

### T16. [M6] Onboarding API (atomic company, owner, GST and trial) and company selection

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, gst
- **Depends on:** T5, T7, T14 · **Covers:** S5, S12 AC3, S1 AC5
- **Acceptance criteria:**
  - `POST /api/onboarding/company` validates per S5 AC1–AC2, reusing the #25 ABN and GST registration validation.
    Unknown or forbidden keys (`companyId`, `isDemo`, trial dates, `role`) give 400.
  - One transaction creates:
    - the company (`isDemo = false`, `access_mode = trial`, trial dates from `trialWindow(now)`);
    - the owner membership;
    - the GST registration when registered;
    - the session's active company;
    - audit events `company.created`, `company.profile_set`, `gst_settings.registration_added` (when registered) and
      `trial.started`.

    An injected failure at each step leaves nothing behind.
  - Idempotency: the same `Idempotency-Key` sent twice, or concurrently, gives exactly 1 company and returns the same
    ID. A different key after a successful creation gives 409 `self_service_limit`.
  - An existing member of another company can create one company, and their memberships are unchanged.
  - `POST /api/session/company` switches only to an active membership, and returns 404 otherwise.
  - The trial-start audit and the company export include the trial fields.

### T17. [M6] Trial access in actor resolution, trial status API and permissions

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend
- **Depends on:** T5, T7 · **Covers:** S8 (server), S9 AC1 (state), S12 AC1
- **Acceptance criteria:**
  - `resolveActor()` returns `actor.access` (mode, lastDay, readOnly computed with the database `now()`) from the same
    membership query. No extra query per request, and a query-count test proves it.
  - `trial.read` (owner, manager, accountant) and `trial.request_extension` (owner) are added to `packages/authz`, with
    tests pinning them.
  - `GET /api/company/trial` returns the full status to `trial.read` holders and `{ readOnly }` only to employees and
    subcontractors. A projection test checks the key sets.
  - Demo and `unrestricted` companies return `mode: unrestricted` and never `readOnly`.
  - The phase and N match `packages/domain` for the T5 fixtures.

### T18. [M6] Central read-only write guard and allowlist

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, security, testing
- **Depends on:** T7, T17 · **Covers:** S9, S12 AC2
- **Acceptance criteria:**
  - `withPolicy` refuses unsafe methods for a read-only company with 403 `{ code: "company_read_only" }`, unless the
    route is in `READ_ONLY_ALLOWED` with a reason.
    - The database error `jobflow_company_read_only` maps to the same response.
    - Server actions that write company data must refuse a read-only company (none exists yet; add the check with
      the first one).
  - `withAudit` accepts `readOnlyExemption`. Handlers pass it only for the cases in ADR 0004 D4:
    - membership deactivation without a role change;
    - invitation revoke;
    - invitation accept before expiry;
    - exports;
    - issued-document PDF;
    - extension request;
    - document cleanup.
  - A TypeScript/SQL parity test checks the exemption lists match.
  - A unit test enumerates every unsafe route from the route matrix. It fails when a route is neither guarded nor in
    the allowlist.
  - An integration test calls **every** unsafe route as an owner of an expired company and asserts 403
    `company_read_only`, except for the allowlist. Allowlisted routes succeed. Every GET page and API still works.
  - Race tests:
    - a write that starts before `read_only_from` and commits after it is rolled back with no partial rows;
    - an extension committed first makes the write succeed.
  - `docs/architecture/authorisation.md` documents the guard and the housekeeping list (S9 AC7).

### T19. [M6] Route gating, public allowlist, safe return path and company chooser

- **Agent:** frontend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** frontend, security
- **Depends on:** T4, T14, T16 · **Covers:** S1, S12 AC3
- **Acceptance criteria:**
  - With no session cookie, `proxy.ts` redirects a **page** outside the public allowlist to `/login?next=<path>`, and
    answers an **`/api/*`** request outside it with `401 { code: "unauthenticated" }` JSON.
    - The public API allowlist is generated from the `withPublic` and `withWebhook` routes, including
      `POST /api/invitations/accept` and `POST /api/webhooks/email`.
    - A test fails if the proxy list, `route-policy.test.ts` and the route files disagree.
    - An e2e test accepts an invitation as a brand-new user with no session.
  - Layouts route by resolution: unverified → `/verify-email/pending`, no membership → `/onboarding`, several →
    `/choose-company`. `/invite` works in every state.
  - `next` accepts only same-origin relative paths. A table test covers `//evil.example`, `/\evil`, `https://…`,
    `javascript:` and encoded variants, which all fall back to `/home`.
  - `/choose-company` lists active memberships and switches through `POST /api/session/company`. The account menu has
    "Switch company" and "Create a company".
  - The sign-in page shows "Create an account". Signed-out pages show no company data, navigation or counts.
  - The `(app)` layout keeps `private, no-store`, and a test asserts the header.

### T20. [M6] Sign-up, check-email, verify, resend, forgot and reset pages

- **Agent:** frontend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** frontend
- **Depends on:** T4, T13, T14, T15 · **Covers:** S2, S3, S4 (UI)
- **Acceptance criteria:**
  - The pages `/signup`, `/signup/check-email`, `/verify-email` (reads `#token` and POSTs it), `/verify-email/pending`,
    `/forgot-password` and `/reset-password` (reads `#token`) are built to the T4 spec.
  - The Turnstile widget is on sign-up, forgot and resend only. Their CSP allows `challenges.cloudflare.com` in
    `script-src` and `frame-src`, and no other page's CSP changes (header test).
  - The token pages send `Referrer-Policy: no-referrer` and remove the fragment from history after reading it.
  - Field errors come from server `fields`. Throttled states show the retry time and the support address.
  - Form data is never written to browser storage.
  - axe passes, keyboard-only completion works, and the pages reflow at 320 px in light and dark.

### T21. [M6] Onboarding step 1, setup checklist and "Create a company" entry

- **Agent:** frontend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** frontend
- **Depends on:** T4, T16, T19 · **Covers:** S5, S12 AC3
- **Acceptance criteria:**
  - `/onboarding` step 1 shows the required and optional fields. GST fields appear only when the answer is yes. The
    form shows "Invited to join a company? Use the invitation link…".
  - One `Idempotency-Key` per form load. Double-clicking submit creates 1 company. A 409 shows "Contact us to set up
    another company" with the support address.
  - After step 1, the user can choose the optional details or "Skip for now". Leaving before submitting stores
    nothing, including nothing in browser storage.
  - The home page shows "Finish setting up your company", which links to the missing details until they're complete
    or dismissed (`/api/company/setup-checklist/dismiss`).
  - axe, keyboard and 320 px checks pass.

### T22. [M6] Trial indicator, banners and read-only UI states

- **Agent:** frontend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** frontend
- **Depends on:** T4, T17, T18 · **Covers:** S8, S9 AC5
- **Acceptance criteria:**
  - The app shell shows `TrialIndicator` on every page and at every breakpoint, for owners, managers and accountants,
    with the exact S8 AC1 copy for each phase. The support email appears in the warning, critical and expired phases.
    Owners also see "Request extension", linking to T28.
  - Employees and subcontractors see no countdown. When expired, they see only "This company's account is read-only.
    Contact your owner."
  - It's a `role="status"` landmark with a text cue, not colour alone, and meets AA contrast in both themes.
  - The warning banner can be dismissed for the session. The expired banner can't.
  - `CompanyAccessProvider` disables create and edit controls on read-only pages with a one-line reason. A component
    test covers at least the invoices, jobs, customers and settings pages.
  - Demo and `unrestricted` companies show no indicator.

### T23. [M6] Company profile extras and logo API

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p1 · **Areas:** backend, security
- **Depends on:** T7 · **Covers:** S6
- **Acceptance criteria:**
  - `PATCH /api/company` accepts phone, business email, website (http/https only) and about (≤ 1000, plain text) per
    S6 AC1. Audit records the changed field names, with redaction.
  - `POST /api/company/logo` checks that the signature is PNG or JPEG, the size is ≤ 2 MiB and the dimensions are
    ≤ 4000², and strips metadata (EXIF and text chunks removed: fixture test).
    - SVG, a renamed HTML file, a polyglot, an oversized file and a decompression-bomb dimension are refused, and
      nothing is left in the store or the database.
  - Replacing a logo creates a new `company_logo` document. Old ones remain, and `documents:cleanup` never deletes
    `company_logo` (test).
  - `GET /api/company/logo/link` returns a short-lived signed link scoped to the company. Cross-tenant access is 404.
  - All of these writes are refused while read-only, through T18.

### T24. [M6] Company details UI: optional onboarding steps, settings fields and logo

- **Agent:** frontend-engineer · **Type:** feature · **Priority:** p1 · **Areas:** frontend
- **Depends on:** T4, T21, T23 · **Covers:** S6, S5 AC7
- **Acceptance criteria:**
  - `/onboarding/details` and `/settings` edit phone, business email (prefilled with the login email), website, about
    and the logo, to the T4 spec.
  - The logo upload previews through the signed link and shows the size, type and dimension errors from the server.
  - "About" renders as text. Typing HTML shows it literally (test).
  - Controls are disabled when read-only (T22) or when the user lacks `company.update`.
  - axe, keyboard and 320 px checks pass.

### T25. [M6] Supplier snapshot extension and PDF logo

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p1 · **Areas:** backend, gst
- **Depends on:** T23 · **Covers:** S7
- **Acceptance criteria:**
  - Issuing an invoice or credit note stores `SupplierSnapshotV2`. Sending a quote stores V2 plus `about`.
  - Drafts render the live profile, and issued or sent documents render the snapshot only.
  - For each snapshot field, including the logo, a test edits the profile after issue or send and proves the view and
    the PDF are unchanged.
  - PDFs embed the logo bytes from private storage through `pdf-lib`, with no URL fetch. Every text field is escaped,
    and a missing optional field leaves no empty label. The renderer version bumps.
  - Pre-M6 invoices render their V1 snapshot unchanged. Pre-M6 sent quotes show "Supplier details not recorded at
    send".
  - Issuing still requires the R4 fields, including the ABN when registered. When fields are missing, the user is
    pointed to settings.
  - A domain-expert sign-off comment on the PR confirms R4 compliance.

### T26. [M6] Platform operator role, guard, TOTP and CLI

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, security
- **Depends on:** T5, T7, T10, T18 · **Covers:** S11 AC1, AC3, AC4, AC6–AC8, S13 AC3, AQ1, AQ2
- **Acceptance criteria:**
  - `isOperator(user)` requires an active `platform_operators` row, membership of `JOBFLOW_OPERATOR_USER_IDS` and a
    verified email. In production it also requires `two_factor_enabled`.
    - `withOperator` and `requireOperator()` return 404 on any failure.
    - A negative test covers signed-out users, each of the five company roles, a revoked operator, an operator missing
      from the allowlist and (in production) an operator without MFA.
  - The Better Auth `twoFactor` plugin (TOTP, trust-device off) is configured. Enrolment is refused for non-operators.
    `/operator/mfa` is the only operator page reachable before enrolment.
  - `pnpm operator enrol-code --user <id>` issues a one-time enrolment code (10 minutes, single use, digest stored,
    audited). `/two-factor/enable` is refused without a valid code. A test shows that a password-only session can't
    enrol without it.
  - The `trialAccess` service provides `extend` and `setAccessMode`, which validate per S11 AC4 and AC8 (demo or
    unknown company → error, no change).
    - Each locks the company, writes an `operator` audit event (before and after values, reason, requestId) with the
      `operator` exemption, and enqueues the "trial extended" email to owners.
    - Concurrent extensions serialise.
  - `pnpm operator grant|revoke|list|extend|access` works as in the contracts doc:
    - grant and revoke write `platform_audit_events`;
    - it refuses without `APP_ENV` or with a non-operator `--as`;
    - there's no HTTP path to it.
  - An extension makes a read-only company writable immediately (T18 test reused).

### T27. [M6] Trial extension requests and operator decision API

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** backend, security
- **Depends on:** T26 · **Covers:** S14, S11 AC2, AC5 and AC7
- **Acceptance criteria:**
  - `POST /api/company/trial/extension-requests` is for owners of trial companies only. Other roles get 403, and
    demo or unrestricted companies get 403.
    - It works while read-only.
    - It creates one pending request (concurrent test) with an audit event.
    - Limits: 3 per 7 days and 24 h after a decline, giving 429 with `retryAfterSeconds`.
  - The operator gets an email with only the S14 AC5 fields and the escaped message.
  - The operator APIs list pending requests (oldest first) and recent decisions with the least-privilege projection
    (key-set test).
    - Approve uses `max(current, yesterdaySydney) + days`.
    - Decline needs a reason.
    - A second, concurrent decision gives 409 with no change.
  - A direct extension closes a pending request as approved and links it. Switching to `unrestricted` closes it.
  - Every active owner with a verified email gets the outcome email, and a `user_notices` entry is shown until it's
    dismissed.
  - Requests and decisions appear in the company export (#62). Owners see "Trial extended by JobFlow operator" (label
    only).

### T28. [M6] Operator area UI and owner trial settings and request UI

- **Agent:** frontend-engineer · **Type:** feature · **Priority:** p0 · **Areas:** frontend
- **Depends on:** T4, T22, T27 · **Covers:** S11, S14 (UI), S10 AC3 (outcome notice)
- **Acceptance criteria:**
  - `/operator`, `/operator/requests/[id]`, `/operator/companies[/id]` and `/operator/mfa` follow T4. They use a
    separate layout with no company shell, and show no link to the operator area for anyone else.
  - Approve, decline, extend and access forms validate on the client and show server errors. A reason is required.
  - `/settings/trial` (owner, manager, accountant) shows the status, the last day and the extension history. Owners
    see the request form, or the pending request's status and time, plus the support address.
  - Request-outcome and threshold notices appear once and can be dismissed through `/api/notices/dismiss`.
  - axe, keyboard and 320 px checks pass.

### T29. [M6] Trial reminder emails and one-time notices

- **Agent:** backend-engineer · **Type:** feature · **Priority:** p1 · **Areas:** backend
- **Depends on:** T10, T17, T27 · **Covers:** S10
- **Acceptance criteria:**
  - `jobs:run` sends at most one threshold per company and last day (7, 3, 1, ended). It sends only the latest one
    that applies when it's late. It never sends an earlier threshold after a later one. Running it twice, or on two
    hosts, sends nothing twice.
  - Emails go only to active owners with a verified email, and never for demo or unrestricted companies.
  - Each email shows the Sydney expiry date, explains read-only, and gives the support email and the link to the
    extension request.
  - An extension re-arms the thresholds against the new last day (test).
  - On the first owner sign-in in each threshold window, a one-time notice (`user_notices`) shows.
  - Sends and failures are logged by row ID, never by address.

### T30. [M6] Scheduled jobs timer (`jobs:run`)

- **Agent:** devops-engineer · **Type:** chore · **Priority:** p1 · **Areas:** infra
- **Depends on:** T10, T29 · **Covers:** E4
- **Acceptance criteria:**
  - `jobflow-jobs.service` and `jobflow-jobs.timer` run every 5 minutes (`Persistent=true`) through the maintenance
    container, following the `jobflow-document-cleanup` pattern.
  - The maintenance environment has the email and outbox keys and nothing else extra.
  - Two overlapping runs are proven safe through the advisory lock, with a recorded test.
  - Failures show up in `journalctl`, and the runbook says how to check the outbox backlog (`failed` count).

### T31. [M6] E2E acceptance suite for sign-up, trial and operator flows

- **Agent:** qa-engineer · **Type:** feature · **Priority:** p0 · **Areas:** testing
- **Depends on:** T19–T22, T24, T28, T29 · **Covers:** NFR testing, S1–S14
- **Acceptance criteria:**
  - Playwright covers these flows with `MemoryTransport` and Turnstile test keys:
    - sign-up → verify → onboarding → app;
    - forgot → reset → sign-in, with old sessions gone;
    - an expired company is read-only for each role, export still works, and the request → operator approve →
      writable again;
    - an invited user joins with no trial;
    - an existing member creates a company and switches.
  - Enumeration timing: sign-up and forgot responses for existing and new emails differ by less than 50 ms at the
    median over 200 runs (integration level).
  - `docs/testing/m6-signup-trial.md` maps every S1–S14 acceptance criterion to a test or a manual staging check,
    including the S1 AC8 edge-cache check from T9.
  - axe sweep: all new pages are added to `a11y-sweep.spec.ts`.

### T32. [M6] Pre-launch security review of sign-up, trial and operator

- **Agent:** security-engineer · **Type:** chore · **Priority:** p0 · **Areas:** security
- **Depends on:** T3, T9, T11–T18, T23, T26, T27 · **Covers:** NFR security (T01, T07–T11)
- **Acceptance criteria:**
  - `docs/security/m6-signup-review.md` reviews:
    - enumeration;
    - token handling;
    - throttles behind Cloudflare (real IP);
    - Turnstile;
    - CSRF and origin on all new routes;
    - open redirects;
    - logo upload;
    - PDF embedding;
    - the read-only guard's completeness;
    - the operator boundary and MFA;
    - CSP changes;
    - secrets and egress.
  - Every finding is fixed, or filed as an issue with a severity. No high or critical finding is left open at launch.
  - The production launch checklist confirms all of these:
    - non-placeholder legal versions (T8);
    - operator TOTP enrolled;
    - DNS SPF, DKIM and DMARC passing;
    - the edge-cache check passing;
    - `SIGNUP_ENABLED` set deliberately.

### T33. [M6] Docs: README, user guide, operator runbook and rule-file wording

- **Agent:** tech-writer · **Type:** docs · **Priority:** p1 · **Areas:** documentation
- **Depends on:** T9, T12, T26, T30 · **Covers:** NFR docs, ADR 0004 follow-ups
- **Acceptance criteria:**
  - The README and `docs/user/` cover signing up, verifying, onboarding, the trial and read-only, and requesting an
    extension.
  - `docs/ops/operator.md` covers grant and revoke, MFA enrolment, deciding requests, the CLI fallback and the outbox
    backlog check.
  - `AGENTS.md`, `CLAUDE.md` (commands: `pnpm jobs:run`, `pnpm operator`), `docs/architecture/authorisation.md`,
    `user-access.md`, `docs/SECURITY.md` and `docs/ops/*` are updated per the ADR 0004 follow-up list, and checked for
    consistency between `AGENTS.md` and `CLAUDE.md`.
  - The CHANGELOG has an entry for M6.

## Notes for issue creation

- **What already exists.** No tasks were created for these:
  - design previews in production (`design/gate.ts` already returns 404);
  - CSRF and origin guards;
  - the shared database throttle table;
  - private document storage and signed links;
  - invitations;
  - company export.

  Those tasks extend existing code.
- **S12** has no task of its own. It's covered by T13 (AC4), T16 and T19 (AC3), T17 (AC1), T18 (AC2) and T31.
- When creating issues, replace `T<n>` with `#<issue>` in "Depends on". Only T2, T3, T4, T5, T6, T8 and T9 start as
  `status:ready`.
