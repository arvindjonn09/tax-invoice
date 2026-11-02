# Public sign-up, onboarding and 30-day trial

Milestone: **M6 Public launch** · Status: requirements draft · Author: product-analyst · Date: 2 November 2026

## Problem and goal

JobFlow will be published at `https://jobflow.shivomsangha.com` (behind Cloudflare). Today a company can only be
created by the demo seed or an operator, and users only arrive through owner invitations (#27). Any Australian
contractor should be able to create an account, set up their company once, and try JobFlow with real data for 30 days.
When the trial ends, their records stay readable and exportable but nothing new can be created until an operator extends
the trial.

## Personas

- **Prospective owner:** a sole trader or small-business owner who finds JobFlow and signs up. They become the
  `owner` of a new company.
- **Invited member:** someone an owner invites (#27) as manager, accountant, employee or subcontractor. They join an
  existing company and never get a trial of their own.
- **Existing user:** a person who already has a JobFlow account (invited or seeded) and now wants their own company.
- **Operator:** the person running the deployment (the project owner). Extends trials manually. This is not an in-app
  role in this epic.
- **Abuser:** a bot or person who mass-creates accounts, enumerates emails, or restarts trials.

## Decisions already made (owner, not reopened)

1. When the trial expires, the company becomes **read-only**. Users can still sign in, view and export. They can't
   create, issue or approve anything until an operator extends the trial. Paid billing is out of this epic.
2. **Email verification is required** before using the app. A transactional email provider will be chosen by a spike.
   Self-service password reset is included.
3. Payslips and payroll stay out of scope. Company details are reused on invoices, quotes, credit notes and PDFs.
4. Milestone: **M6 Public launch**.

## Changes to existing decisions

- **ADR 0003 says "No public sign-up".** This epic reverses that. The architect must amend ADR 0003, or write a new
  ADR that supersedes that section, before the sign-up story starts. ADR 0003 also lists "password-reset email" as
  unimplemented. This epic implements it.
- **#27 invitations** say that no email is sent. That stays true for invitations in this epic. Sending invitations by
  email is listed under Later.
- **Rate limiting** keys on `x-forwarded-for` (ADR 0003). Behind Cloudflare, the client IP must come from a header the
  client can't spoof. This is an infra prerequisite (see E3).

## Trial company compared with demo company

| | Trial company (this epic) | Demo company (#21) |
|---|---|---|
| Data | Real business data | Synthetic only |
| `isDemo` | Always `false`. Sign-up can never create a demo company | `true` |
| "Demo Data" indicator | Never shown | Always shown |
| Allowed in production | Yes | No. Seeding is refused |
| Trial clock and read-only state | Yes | No. Demo companies are exempt and never expire |
| Retention | 5-year business-record rules apply (#62) | Not retained as business records |

## Glossary and time rules

- **Sydney date:** a calendar date in `Australia/Sydney`, including daylight saving. All instants are stored in UTC.
- **Trial start:** the instant the company is created (S5). This is recommended over the email-verification instant
  because:
  - verification always happens before company creation, so a verified user with no company has nothing to trial;
  - invited users verify their email but must never start a trial.
- **Last trial day:** the Sydney date of the trial start plus 29 days. That gives 30 calendar days of access counting
  the start day. Example: a company created at 2 Nov 2026 15:00 Sydney has a last trial day of 1 Dec 2026.
- **Read-only from:** 00:00 Sydney on the day after the last trial day, stored as a UTC instant. In the example that's
  2 Dec 2026 00:00 AEDT, which is 2026-12-01T13:00Z.
- **Days remaining (N):** the last trial day minus today's Sydney date, plus 1. So N = 30 on the creation day, 1 on the
  last day, and 0 or less once read-only.
- **Trial state:** `normal` (N ≥ 8), `warning` (2 ≤ N ≤ 7), `critical` (N = 1), `expired` (N ≤ 0). The state is
  always computed on the server from the stored instant, never from the browser clock.

## User stories and acceptance criteria

Priority uses MoSCoW. **Must** = P0, required for the public launch. **Should** = P1.

### S1. Public entry and routing (Must, P0)

As a visitor, I want to be sent to the right place for my account state, so that I'm always asked to sign in or sign up,
and I never see app data unauthenticated.

1. Given I'm not signed in, when I open `/` or any app page, then I see the sign-in page, which has a prominent
   "Create an account" link to sign-up. No company data, navigation or user counts appear.
2. Given I'm not signed in and I open a deep link such as `/invoices/123`, when I sign in, then I'm returned to that
   path. The return target is accepted only if it's a relative path on the same origin. Anything else, including
   `//evil.example`, absolute URLs and `javascript:`, falls back to the home page.
3. Given I'm signed in and my email is unverified, when I open any app page, then I'm sent to the "verify your email"
   page (S3). The only public routes allowed are listed in AC6.
4. Given I'm signed in, verified and have no active membership, when I open any app page, then I'm sent to onboarding
   (S5). If I also hold an invitation link, `/invite` still works (S12).
5. The remaining signed-in, verified cases route as follows.
   - Given my active memberships need a choice (`choose-company`), then I see the company chooser.
   - Given exactly one active membership, or a remembered one, then I see the app home for that company.
   - Given that company is expired, then the app opens with the read-only banner (S8, S9).
6. Public routes are an explicit allowlist, and every other route needs a session (deny by default):
   - sign-in, sign-up, verify-email (page and link handler) and resend;
   - forgot-password and reset-password;
   - `/invite`, terms, privacy and health.
7. In production, `/design-previews` and `/design-system` require sign-in or are disabled. **Assumption:** they're not
   public marketing pages.
8. Authenticated and private pages and API responses are `private, no-store` and are never cached by Cloudflare. A
   staging check proves that a second browser doesn't receive another user's cached page.

### S2. Sign up (Must, P0)

As a prospective owner, I want to create an account with my name, email and password, so that I can set up my company.

1. Given the sign-up form, when I submit a valid name, email and password and tick the terms and privacy box, then:
   - an unverified account is created;
   - a verification email is sent (S3);
   - I see "Check your email to verify your address", and no session is granted for app pages.
2. **Validation**, all checked on the server:
   - Name: 1–200 characters after trimming, with control characters rejected.
   - Email: syntactically valid and ≤ 320 characters. It's trimmed and lower-cased before storing and comparing.
   - Password: 12–128 characters (ADR 0003). Confirmation must match. There are no composition rules.
   - Terms and privacy: acceptance is required.
3. **Recommended addition:** reject passwords that appear in a known-breached list. The owner decides whether to
   include this (OQ8).
4. **No account enumeration:**
   - Given the email already belongs to any account (verified, unverified, invited, deactivated or demo), when I sign
     up, then I see exactly the same response as a new sign-up.
   - In that case the existing account is not changed (its name and password are untouched).
   - The address receives an "an account already exists. Sign in or reset your password" email instead of a
     verification email.
   - Response timing must not reliably reveal which case happened. QA tests the median difference.
5. Given two concurrent sign-ups with the same email, then exactly one account exists and both responses are the
   generic one.
6. **Terms record:** the accepted terms version, privacy version and acceptance instant are recorded against the user.
7. **Production guard:** in production, sign-up for `@example.test` or any reserved TLD (`.test`, `.example`,
   `.invalid`, `.localhost`) is refused with a generic validation error. No email is sent.
8. **Abuse protection:**
   - Sign-up is throttled per client IP. The recommended starting value is 5 per hour, kept in shared database
     storage like the existing limits. Excess requests return 429 with a retry hint.
   - **Recommended:** a Cloudflare Turnstile (or equivalent) challenge on sign-up, forgot-password and resend,
     verified on the server. A failed or missing token returns a generic error and creates nothing. The owner decides
     (OQ5).
9. **Email content:**
   - Emails sent to an address that isn't verified yet contain no attacker-controlled free text. No user-entered name
     or company name appears in them, so they can't be used to relay spam.
   - Emails contain no secrets other than the single-use link.
10. Sign-up doesn't create a company, membership or trial.

### S3. Email verification and resend (Must, P0)

As a new user, I want to verify my email address, so that I can use JobFlow and recover my account later.

1. **The link:**
   - Given I signed up, then the email contains a single-use verification link.
   - The link expires after 24 hours (**Assumption**).
   - The token is random, at least 128 bits, and stored only as a digest or equivalent. It's never logged, put in
     audit metadata or sent to third parties. Pages that receive it send `Referrer-Policy: no-referrer`.
2. Given I open a valid link, then my email is marked verified, the token is consumed, and I'm taken to sign-in. If I'm
   already signed in, I go straight on to onboarding or the app (S1).
3. Given I open an expired, consumed or tampered link, then I see "This link is invalid or has expired" with a resend
   option. Nothing changes.
4. Given I sign in with the correct password while unverified, then I can only reach the verify page. That page shows
   the address and offers "Resend email" and "Sign out".
5. **Resend:**
   - Resending invalidates earlier unconsumed verification tokens.
   - It's throttled to 1 per minute and 5 per day per account, plus the IP limit. When throttled, the user sees when
     they can retry.
   - The public resend form, used without a session, returns the same response whatever the address.
6. Accounts that existed before this epic, including invited users with `emailVerified = false`, must verify on their
   next sign-in. This is required because password reset (S4) emails the account address, and an unverified address
   could belong to someone else. The one exception is demo accounts outside production, which are exempt because they
   can't receive email.
7. Completing a password reset (S4) also marks the email as verified, because it proves the user controls the address.

### S4. Password reset (Must, P0)

As a user who forgot my password, I want to reset it by email, so that I can get back into my account without an
operator.

1. Given the forgot-password form, when I submit any email, then I always see "If an account exists, we've sent a
   link". The response time is similar for both cases. Only an existing account that isn't a production demo account
   receives an email.
2. **The link:**
   - It's single-use and expires after 1 hour (**Assumption**).
   - The token is handled like the verification token in S3 AC1.
   - Requesting a new link invalidates earlier links.
3. Given a valid link, when I set a new password (12–128 characters, confirmed), then:
   - the password is replaced;
   - every existing session for my account is revoked;
   - my email becomes verified;
   - a "your password was changed" notice is sent to the address;
   - I'm asked to sign in.
4. Given an invalid, expired or used link, then the password is unchanged and I can request a new one.
5. **Throttling:** 3 requests per account per hour and 10 per IP per hour, plus Turnstile if OQ5 is accepted. Throttled
   requests still return the generic message. They don't send an email and they're counted for monitoring.
6. A reset never grants company access by itself. Deactivated memberships stay deactivated (#27).
7. Changing the password while signed in, and changing the email address, are out of scope (Later).

### S5. Onboarding: create my company (Must, P0)

As a verified user with no company, I want to enter my core business details once, so that my company exists, I'm its
owner, and my trial starts.

1. Given I'm verified, when I reach onboarding, then step 1 "Your business" asks for the required fields:
   - **Business (trading) name:** required, 1–200 characters.
   - **GST registered?** yes or no: required.
   - **If yes:**
     - ABN is required, normalised to 11 digits (spaces allowed on input) and must pass the checksum (#25).
     - The GST registration effective date and the accounting basis (cash or non-cash) are required. They use the
       same validation and effective-dated record as #25.
     - BAS period (monthly or quarterly) defaults to quarterly.
   - **If no:** ABN is optional, but still checksum-validated when given.
2. Step 1 also shows the optional fields: legal name (≤ 200) and the address (line 1 and 2, suburb, state from the 8
   Australian codes, 4-digit postcode), all validated like #25.
3. **Atomic creation:** given valid step 1 input, when I submit, then one transaction creates:
   - the company, with `isDemo = false`;
   - my `owner` membership;
   - the GST registration record when it applies;
   - the trial (start instant and read-only-from instant);
   - audit events: company created, profile set, GST registration set and trial started. These carry safe metadata
     only, with no ABN in logs.

   If any part fails, nothing is created.
4. Idempotency: a double-click, retry or two tabs produce exactly one company. The second request returns the same
   company.
5. **Self-service limit:** a user may create at most **one** company through self-service. **Assumption**, pending
   OQ6. A further attempt shows "Contact us to set up another company" and creates nothing.
6. The server rejects a client-supplied `companyId`, `isDemo`, trial date or role.
7. After step 1, my session's active company becomes the new company, and I continue to the optional steps (S6) or
   choose "Skip for now".
8. **Leaving and resuming:**
   - If I leave before submitting step 1, nothing is stored on the server. Form data isn't kept in browser storage,
     and next time I start again at step 1.
   - If I leave after step 1, I land in the app. A "Finish setting up your company" checklist on home links to the
     missing optional details until they're complete or I dismiss it.
9. Onboarding states "Invited to join a company? Use the invitation link from your owner instead", so that invitees
   don't create a trial company by mistake.
10. Duplicate ABN across companies is allowed and doesn't reveal that another company uses it (OQ7).

### S6. Onboarding: contact details, about and logo (Should, P1)

As an owner, I want to add my contact details, a description and my logo, so that my documents look professional.

1. The optional steps, also editable later in company settings by users with `company.update` (owner), are:
   - **Phone:** 8–20 characters of digits, spaces, `+`, `(` and `)`. It must contain 8–15 digits. **Assumption.**
   - **Business email:** a valid email of up to 320 characters, prefilled with my login email. It's a display value
     only, isn't used for sign-in and isn't verified.
   - **Website:** an `http`/`https` URL of up to 200 characters. Every other scheme is rejected.
   - **About the company:** plain text of up to 1000 characters with line breaks allowed. HTML is shown as text,
     never rendered.
2. **Logo:**
   - PNG or JPEG only, checked by file signature and not by extension. SVG is refused because of script risk.
   - Up to 2 MB and up to 4000×4000 px. These limits are an **Assumption**.
   - It's stored in private storage with a random key and served only through an authenticated, tenant-scoped,
     short-lived signed link (T07).
   - It's re-encoded or validated on the server and its metadata is stripped.
   - Rejected files leave nothing behind.
3. **Replacing the logo** creates a new stored version. Versions referenced by issued documents are kept for the
   retention period and are never overwritten.
4. Every profile change writes an audit event with the changed field names and safe values. The ABN is redacted in
   logs.
5. Edits are allowed while the trial is active and refused while read-only (S9).

### S7. Reuse company details on documents (Should, P1)

As an owner, I want my details to appear automatically on every document, with issued documents never changing, so
that my records stay accurate.

1. **Snapshots:**
   - **Invoices and credit notes:** when one is issued, its supplier snapshot holds the business name, legal name, ABN,
     address, phone, business email, website and a reference to the current logo version. The snapshot already holds
     the name, legal name, ABN and address.
   - **Quotes:** when a quote is sent, it stores the same supplier snapshot, plus "about the company". Quotes freeze
     at send (#44) but currently have no supplier snapshot.
2. Draft and unsent documents show the live profile.
3. Given an issued invoice or credit note, or a sent quote, when the profile, including the logo, is later edited, then
   its screen view and PDF still show the snapshot values. A test proves this for each field.
4. PDFs:
   - PDFs render from the snapshot only.
   - The logo is embedded from private storage on the server. The renderer never fetches a URL (T08).
   - Every text field is escaped.
   - A missing optional field leaves no empty label.
5. Issuing a tax invoice still requires the details the tax-invoice rules need, including the ABN when GST-registered.
   If they're missing, the user is sent to company settings instead of issuing.
6. **Documents issued before this epic:**
   - Invoices issued before this epic keep their existing snapshot. The new fields are absent and never back-filled.
   - Quotes sent before this epic have no supplier snapshot. They show "Supplier details not recorded at send" and
     never the live profile.
7. If a quote PDF or customer email doesn't exist yet, it uses this snapshot when it's built. Customer-facing email
   sending is Later. System emails (verification, reset, trial) come from JobFlow and aren't company-branded.

### S8. Trial clock and indicator (Must, P0)

As an owner, I want to always see how long my trial has left, so that I'm not surprised when it ends.

1. Given a trial company, then owners, managers and accountants see a persistent indicator in the app shell, on every
   page and at every breakpoint:
   - **normal:** "N days remaining"
   - **warning:** "N days remaining · Trial expires on 1 Dec 2026", prominent
   - **critical:** "Last day of your trial · Read-only from 12:00 am tomorrow (Sydney time)"
   - **expired:** "Trial ended 1 Dec 2026 · Read-only"
2. Employees and subcontractors see no countdown. In the expired state they see "This company's account is read-only.
   Contact your owner." No trial dates are shown to them.
3. The state isn't conveyed by colour alone. The indicator is a labelled landmark or status that screen readers
   announce. It meets WCAG 2.2 AA contrast in light and dark themes.
4. The warning banner can be dismissed for the current session. The indicator itself can't. The expired banner can't
   be dismissed.
5. **Boundary tests:** the computed N and state are correct for creation just before and just after Sydney midnight,
   for a Sydney date that differs from the UTC date, and across both DST transitions (first Sunday of October and
   first Sunday of April).
6. Demo companies, and companies an operator has marked unrestricted (S13), show no trial indicator.

### S9. Read-only enforcement after expiry (Must, P0)

As the business, I want expired companies to be read-only on the server, so that trial limits can't be bypassed, and
records stay available for the 5-year retention period.

1. **The read-only rule:**
   - Given a company is expired, then every mutating API, server action and route handler for that company is refused
     with 403 and a distinct, documented error code (for example `company_read_only`).
   - The rule is deny by default. Only the actions listed in AC2 are allowed.
   - The check is enforced on the server inside the write transaction, using database time. It's never enforced by the
     UI alone.
   - A test lists every mutating route and asserts that it refuses when read-only, except for the allowlist.
2. **Allowed while read-only**, with the reason for each:
   - **Sign in, sign out, verify email, reset password, select company.** People must be able to reach their records.
   - **View every page they could view before, with the same role scope.** This keeps records accessible.
   - **Exports:** company export (#62), report CSVs (#56), and downloading or generating the PDF of an already-issued
     invoice or credit note. These are renderings of existing records, needed for record-keeping.
   - **Deactivate a membership, revoke a pending invitation, and the session revocation that follows.** These remove
     access, and an owner must be able to cut off a departing employee at any time.
3. **Refused while read-only**, with the reason for each:
   - **Any create, update, issue, send, approve, accept, record, void, credit, upload or finalise action.** This is the
     owner's decision.
   - **Inviting users, reactivating users and changing roles.** These add or widen access, and inviting would grow
     usage during an expired trial.
   - **Editing the company profile, GST settings or logo.** These only affect future documents, which can't be
     created.
   - **Subcontractor bill submissions, employee timesheets and expenses.** These are new records.
4. Given an action started before expiry, when it commits after the read-only instant, then it's refused. No partial
   writes remain.
5. Read-only pages hide or disable create and edit controls, with a one-line reason. The server rule is authoritative.
6. **Extension:** given an operator extends the trial (S11), then all mutations work again immediately. No data is
   lost or changed while read-only.
7. Background jobs that write on a company's behalf, such as scheduled document cleanup, are reviewed. Housekeeping
   that doesn't create business records may continue, and the list is documented.

### S10. Trial notifications (Should, P1)

As an owner, I want reminders before my trial ends, so that I can arrange an extension in time.

1. **Reminder emails:**
   - Given a trial company, then each active owner with a verified email gets an email at N = 7, N = 3 and N = 1, and
     on the first read-only day ("trial ended").
   - Each email shows the expiry date in Sydney time, explains what read-only means, and gives the extension contact
     (OQ3).
2. **Sending rules:**
   - Each threshold is sent at most once per company and trial end date. Retries and multiple instances never send
     duplicates.
   - If sending was delayed past several thresholds, only the latest one that applies is sent.
   - Sends and failures are recorded without the email address in logs.
3. **In-app:** the S8 indicator is the in-app notification. In addition, the first owner sign-in in each threshold
   window shows a one-time notice.
4. Given the trial is extended, then thresholds re-arm against the new end date. The owners get a "trial extended to
   <date>" email.
5. Demo companies and accounts with unverified emails never receive trial emails.
6. Delivery needs a scheduled job runner. Whether one exists is an architecture dependency (E4).

### S11. Operator extends a trial (Must, P0)

As the operator, I want to extend a company's trial with a recorded reason, so that I can help real customers before
billing exists.

1. **Running an extension:**
   - Given operator access (in the MVP, a documented server-side command; there's no web UI), when I run an extension
     for a company with a new last trial day and a reason, then the trial's read-only instant is updated.
   - The reason is 1–500 characters.
2. **Validation:**
   - The new last trial day must be later than the current one, and no earlier than today's Sydney date.
   - It can be at most 365 days from today. **Assumption.**
   - Shortening a trial is refused.
3. **Audit:**
   - Every extension writes an append-only audit event in the company's audit trail. It holds the previous and new
     dates, the reason, the operator identity, a timestamp and a request ID.
   - Company owners see it in audit history as "Trial extended by JobFlow operator".
   - **Architecture note:** `audit_events.created_by` currently requires a company membership. The architect must
     decide how to represent a non-member operator actor (E2).
4. Running the command against a demo company, an unknown company ID or an invalid date fails with a clear error and
   changes nothing.
5. The command refuses to run without explicit operator credentials. It can't be reached over HTTP.

### S12. Invited and existing users (Should, P1)

As an invited member or existing user, I want sign-up and trials to behave sensibly with my existing access, so that I
don't lose access or start a trial by accident.

1. Given I accept an invitation (#27), then I join that company with no trial of my own, and the company's trial state
   applies to me. When it's read-only, my role-scoped view is read-only too.
2. Invitation acceptance remains possible while the company is read-only only if the invitation was created before
   expiry. **Assumption.** No new invitations can be created (S9 AC3).
3. Given I'm a member of a company and want my own business, when I choose "Create a company" from the account menu,
   then:
   - I go through S5. The self-service limit applies.
   - I become the owner of the new company, which has its own trial.
   - My existing memberships are unchanged, and I can switch between the companies.
4. Given an invited user goes to sign-up with their email, then the S2 AC4 behaviour applies ("account exists" email).
   No second account is created.
5. Given a never-member account created by sign-up later receives an invitation, then accepting it while signed in
   works as in #27, and the user doesn't need to create a company.

### S13. Companies that existed before this epic (Must, P0, blocked by OQ1)

As the operator, I want existing companies handled explicitly when trials ship, so that pilot customers aren't locked
out unexpectedly.

1. A migration gives every existing company an explicit access state:
   - demo companies are exempt;
   - non-demo companies get the state chosen in OQ1. The recommendation is `unrestricted`: no trial and no indicator,
     set by the operator and audited.
2. An operator can move an `unrestricted` company onto a trial, or back, through the S11 command with a reason. Every
   change is audited.
3. No existing company becomes read-only as a side effect of the migration. A migration test proves this.

## Enabling work (not user stories; separate issues)

- **E1. Spike:** transactional email provider (research-dev). It must cover:
  - Australian or GDPR-grade data handling, cost and deliverability;
  - SPF, DKIM and DMARC for the sending domain;
  - bounce and complaint handling, and keeping the API key in a secret store.
- **E2. ADR (architect):**
  - amend ADR 0003 for public sign-up, verification and reset;
  - define the company access state model (trial, unrestricted, read-only derived from time);
  - choose the operator actor representation in the audit trail;
  - add a central mutation guard;
  - record the user-level security log for sign-up, verification and reset, which have no company.
- **E3. Infra (devops):**
  - Cloudflare in front of the origin. The origin only accepts Cloudflare traffic, or a tunnel, so the trusted client
    IP header (for example `CF-Connecting-IP`) can't be spoofed;
  - cache bypass for dynamic routes;
  - HSTS;
  - `BETTER_AUTH_URL` set to the public origin;
  - Turnstile keys if OQ5 is accepted.
- **E4. Scheduler** for trial emails (architect and devops). It must be idempotent across instances.
- **E5.** Terms of Service and Privacy Policy pages, with content from the owner (OQ2).

## Edge cases and validation rules

- **Empty or whitespace input:** trimmed before validation. Empty required fields are rejected with field-level
  messages.
- **Case and Unicode in email:** stored lower-case and compared case-insensitively. Internationalised addresses are
  accepted if the email provider supports them (E1). Otherwise they're rejected with a clear message.
- **Names:** Unicode allowed. They're escaped everywhere: HTML, PDF and email.
- **Duplicates:** the same email for two accounts is impossible. A duplicate company from a double-submit is
  impossible (idempotency). A duplicate ABN across companies is allowed (OQ7).
- **Concurrency:**
  - simultaneous sign-ups;
  - verification link clicked twice (the second click shows "already verified" and nothing changes);
  - reset link used twice (single use);
  - expiry while a write is in flight (refused, S9 AC4);
  - extension and expiry at the same instant (whichever commits first wins, and the outcome is consistent).
- **Large inputs:** request bodies are bounded (for example 4 KiB for auth forms, matching #27), and logos are bounded.
  Oversized requests return 413 or 400 and store nothing.
- **Locale:** dates are shown as `d MMM yyyy` in Sydney time. The app has no currency impact. The trial has no money
  amounts.
- **Deactivated owner:** a company whose only owner is deactivated can't happen (#27 keeps one active owner).
- **Unverified, abandoned accounts:** they can't create companies. Someone who mistyped their email can't block the
  real owner, because the real owner can use password reset, which proves control and verifies the address. Purging
  them is Later.

## Non-functional requirements

- **Security:**
  - All auth endpoints keep CSRF and origin checks (T09) and use shared database rate limits.
  - Tokens are hashed at rest, single-use and never logged.
  - Responses are generic, so they don't enumerate accounts.
  - Sessions are revoked on password reset.
  - There are no open redirects.
  - The Turnstile secret is server-only.
  - Security review by security-engineer is required before launch, covering T01, T07, T08, T09, T10 and T11, plus a
    new threat-model entry for public sign-up abuse and email abuse.
- **Privacy:**
  - Collect only the listed fields.
  - Never log emails, ABNs, phone numbers or tokens.
  - Record terms and privacy acceptance.
  - Records stay retained under #62. Account or company deletion is out of scope.
- **Performance:**
  - Sign-up, verify and reset requests respond within 1 s at p95, excluding email delivery.
  - Emails are handed to the provider within 60 s at p95.
  - The trial-state check adds no more than one indexed lookup per request.
- **Accessibility:**
  - All new pages meet WCAG 2.2 AA: keyboard operable, visible focus, labelled errors linked to fields, and reachable
    at 320 px width.
  - Turnstile must offer an accessible fallback.
- **Audit:**
  - Company audit events cover company creation, profile and logo changes, GST registration, trial start, extension
    and access-state change.
  - User-level security events cover sign-up, verification, reset requested and completed, and throttling. They go in
    a log without PII values (E2).
- **Testing:**
  - Integration tests cover enumeration resistance, throttles, token expiry and reuse, atomic onboarding, the
    read-only allowlist across every mutating route, the Sydney/DST boundaries and the snapshot immutability.
  - Playwright covers sign-up → verify → onboarding → app, reset, and expired read-only, with the email provider
    stubbed.

## Scope

**In:** S1–S13 and E1–E5.

**Out:**
- paid billing, subscriptions and payment collection;
- payslips, payroll, PAYG, STP and super;
- social or SSO login;
- MFA (still assessed under #61);
- a web UI for operators;
- automatic trial extension;
- deleting a company or account.

**Later:**
- invitation emails;
- customer-facing document emails using the S7 snapshot;
- change email or password while signed in;
- purging unverified accounts;
- blocking disposable email domains;
- billing that replaces manual extension;
- an operator dashboard;
- detecting duplicate ABNs and restarted trials;
- configurable trial length.

## Assumptions (to confirm)

1. The verification link lasts 24 h and the reset link 1 h.
2. The logo is PNG or JPEG, ≤ 2 MB, ≤ 4000×4000 px.
3. The phone format rule is the one in S6 AC1.
4. Each user can self-create one company.
5. An operator extension can be at most 365 days.
6. Invitations created before expiry can still be accepted while read-only.
7. Design previews aren't public in production.
8. "About the company" appears on quotes only, not on tax invoices.
9. The trial is a fixed 30 days.

## Open questions

| # | Question | Blocking? |
|---|---|---|
| OQ1 | What happens to companies that exist before launch (pilot or staging)? Recommendation: `unrestricted`, not a new trial. | **Blocking for S13.** It decides whether the migration can lock anyone out |
| OQ2 | Who supplies the Terms of Service and Privacy Policy text and version? JobFlow handles customers' personal information. | **Blocking for public launch** (S2 AC1 needs a document to accept). Build can proceed with placeholder versions outside production |
| OQ3 | Which contact channel do expired customers use to request an extension (support email or form)? It appears in the banner and emails. | **Blocking for S8 expired copy and S10** |
| OQ4 | What sender address and domain should be used (for example `no-reply@jobflow.shivomsangha.com`)? Can the owner add SPF, DKIM and DMARC DNS records in Cloudflare? | **Blocking for S3, S4 and S10** (with E1) |
| OQ5 | Should Cloudflare Turnstile be used on sign-up, forgot-password and resend? Recommendation: yes. | Not blocking. Rate limits alone are acceptable initially |
| OQ6 | Self-service company limit per user: 1 (recommended, prevents trial restarts) or more? | Not blocking. The default is 1 |
| OQ7 | Should a duplicate ABN across companies be blocked, warned about, or silently allowed? Recommendation: allow, and leave flagging to the operator for Later. Blocking would let a squatter lock out the real business. | Not blocking |
| OQ8 | Should breached-password screening be added (needs an external lookup or a bundled list)? | Not blocking |
| OQ9 | Should owners also be able to see the trial state in the company export or settings history? | Not blocking |

## Recommended order and hand-off

1. In parallel: **E1** (research-dev spike), **E2** (architect ADR) and **E3** (devops), with the owner answering OQ1–OQ4.
2. **S1, S2, S3, S4** need E1, E2 and E3.
3. **S5**, then **S8, S9, S11, S13**: the trial core, all Must.
4. **S6, S7, S10, S12**.

No domain-expert regulatory input is needed, apart from confirming that S7's snapshot fields still satisfy the
tax-invoice content rules (R4 in `docs/research/domain-gst-profit.md`). Next agent: **architect** (E2), with
**research-dev** (E1) in parallel.
