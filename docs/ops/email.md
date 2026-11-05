# Outgoing email: pacing and suppression (#259)

JobFlow sends through Zoho Mail SMTP as `admin@shivomsangha.com` (ADR 0004 D7). Zoho allows **50–500 messages per
rolling hour, set dynamically**. Going over blocks **all** sending for up to an hour, including verification and
password-reset emails. So the outbox dispatcher paces itself.

## What the dispatcher does

- **Cap.** It sends at most `EMAIL_MAX_PER_HOUR` in any rolling hour. The default is **40**, below Zoho's lowest
  figure.
  - The count covers emails sent in the last hour plus emails in flight.
  - Claims are serialised with a Postgres advisory lock, so several app processes together still stay under the cap.
  - Emails beyond the cap stay `pending` for a later dispatch.
- **Account emails first.** `verify_email`, `account_exists`, `password_reset` and `password_changed` are claimed
  before trial reminders and notices, however old those are.
- **Throttling replies.** An SMTP 4xx reply, or a 554 whose text mentions a limit or quota, means Zoho is throttling.
  - That message goes back to `pending` without using one of its 8 attempts, so it is never marked `failed`.
  - **Every** pending email waits 15 minutes before the next try, because Zoho would refuse them all.
  - The log line is `email.rate_limited`: outbox id, kind and error class only, never an address or the reply text.
- **Suppressed addresses** are checked when an email is queued and again just before it is sent. An email queued
  before the address was suppressed is cancelled, and logged as `email.suppressed` with no address.

If `email.rate_limited` shows up on more than an occasional day, lower `EMAIL_MAX_PER_HOUR`, or move to the
transactional-provider fallback (Amazon SES Sydney, `docs/research/email-provider.md`).

## Suppressing an address by hand

Use this after a hard bounce (the NDR arrives in the `admin@` mailbox), a complaint, or a request to stop:

```sh
pnpm email suppress --address <address> --reason bounce|complaint|manual
pnpm email unsuppress --address <address>
```

- Run it from a checkout on the host with the app's `DATABASE_URL` and `EMAIL_OUTBOX_KEY`. A different key gives a
  different digest, so the suppression silently wouldn't match.
- Only the address's HMAC is stored, in `email_suppressions`, and the address itself is never printed or logged. The
  command prints a 12-character hash prefix.
- Each change is recorded in `platform_audit_events` (`email.suppressed` or `email.unsuppressed`, actor `operator`,
  with the hash and reason). Repeating a command changes nothing and records nothing.
- Rotating `EMAIL_OUTBOX_KEY` drops the whole suppression list (ADR 0004 D7).
