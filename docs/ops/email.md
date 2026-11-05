# Outgoing email: pacing and suppression (#259)

JobFlow sends through Zoho Mail SMTP as `admin@shivomsangha.com` (ADR 0004 D7). Zoho allows **50–500 messages per
rolling hour, set dynamically**. Going over blocks **all** sending for up to an hour, including verification and
password-reset emails. So the outbox dispatcher paces itself.

## What the dispatcher does

**Cap.** It makes at most `EMAIL_MAX_PER_HOUR` SMTP attempts in any rolling hour.
- The default is **40**. A value that isn't a whole number from 1, including `0`, logs `email.config_invalid` and
  uses 40.
- Every SMTP attempt is counted (sent, failed or throttled) in `email_send_attempts`, which is pruned after two hours.
  An email cancelled before SMTP (suppressed, or with no payload) gives its place back.
- **Known gap:** the attempts table starts empty when this first deploys, so in the first hour up to twice the cap could
  go out, counting what the old code sent. Keep `EMAIL_MAX_PER_HOUR` at 40 or below, under Zoho's lowest limit, so that
  stays safe.
- Claims are serialised with a Postgres advisory lock, so several app processes together still stay under the cap.
- Emails beyond the cap stay `pending`.

**Sweep.** Every production app process dispatches the outbox once a minute (`instrumentation.ts`), so held-back
email goes out on a quiet site too.
- `EMAIL_SWEEP=off` turns it off; `EMAIL_SWEEP=on` turns it on in development.
- A lasting fault, such as missing SMTP settings, logs `email.sweep_failed` once, then every 60th failed sweep (hourly).
- A sweep never overlaps the previous one in the same process.

**Account emails first.** `verify_email`, `account_exists`, `password_reset` and `password_changed` are claimed
before trial reminders and notices, however old those are.

**Throttling and block replies.**
- What counts:
  - An SMTP 4xx reply, or a 5xx whose text names a limit ("quota", "rate limit", "sending limit", "too many messages",
    "limit exceeded", "unusual sending activity"), is **throttling**.
  - Zoho's `554 5.1.8 Email Outgoing Blocked`, or "account blocked", is a **block**.
  - Other 5xx replies are ordinary failures, including "corporate policy", "Content moderated" and "generate NDR".
- What happens:
  - **Every dispatcher pauses.** The pause is stored in `email_dispatch_state`, so emails queued during it, and stale
    `sending` rows, wait too. A pause is only ever extended: a later 421 never shortens a block another send set.
  - The pause is 15 minutes, doubling for each throttling reply in a row (30, 60, 120), capped at 4 hours. A block
    waits at least an hour.
  - A successful send resets the doubling.
  - The refused email uses **none of its 8 attempts**. It goes behind the others, so the next try is a different
    email.
  - An email that meets **5** throttling or block replies (`MAX_RATE_LIMITED_PER_ROW`) is marked `failed`, with its
    payload deleted, so one stuck email can't keep pausing the queue (owner decision, 5 November 2026). The log line
    carries `markedFailed: true`. That log line is the only alert for now; a manual resend and an outbound operator
    alert are #270.
  - Logged at **error** as `email.rate_limited` or `email.provider_blocked`: outbox id, kind and error class only,
    never an address or the reply text.

**Suppressed addresses** are checked when an email is queued and again just before it is sent. An email queued before
the address was suppressed is cancelled, and logged as `email.suppressed` with no address.

If `email.rate_limited` shows up on more than an occasional day, lower `EMAIL_MAX_PER_HOUR`. If `email.provider_blocked`
appears at all, check the Zoho account. Either can be a reason to move to the transactional-provider fallback (Amazon SES
Sydney, `docs/research/email-provider.md`).

## Suppressing an address by hand

Use this after a hard bounce (the NDR arrives in the `admin@` mailbox), a complaint, or a request to stop.

**The address goes in on standard input.** Never put it on the command line: the script runner echoes its arguments, and the
shell keeps them in its history. Typing it at the `Address:` prompt works too.

```sh
printf '%s\n' 'someone@example.com' | pnpm email suppress --reason bounce|complaint|manual [--by <name>]
printf '%s\n' 'someone@example.com' | pnpm email unsuppress [--by <name>]
```

- It needs the app's `DATABASE_URL` and `EMAIL_OUTBOX_KEY`. A different key gives a different digest, so the
  suppression silently wouldn't match.
- Only the address's HMAC is stored, in `email_suppressions`. The command prints a 12-character hash prefix and never
  the address.
- Each change is recorded in `platform_audit_events` (`email.suppressed` or `email.unsuppressed`, actor `operator`),
  with the hash, the reason and **who ran it** (`--by`, or the OS user name). Repeating a command changes nothing and
  records nothing.
- Rotating `EMAIL_OUTBOX_KEY` drops the whole suppression list (ADR 0004 D7).

**On the Compose staging host**, Postgres has no published port. Run the command in the one-off `migrate` image, which
has the repository, `tsx` and the database network. Its `DATABASE_URL` is the owner role, which may write these
tables. Take only `EMAIL_OUTBOX_KEY` from `web.env`; passing it through the environment keeps it out of the process
list.

```sh
cd /opt/jobflow
EMAIL_OUTBOX_KEY="$(sed -n 's/^EMAIL_OUTBOX_KEY=//p' infra/staging/env/web.env)" \
  docker compose -f infra/staging/compose.yml --env-file infra/staging/env/compose.env \
  run --rm -T -e EMAIL_OUTBOX_KEY migrate \
  node_modules/.bin/tsx scripts/email/cli.ts suppress --reason bounce --by "$USER" \
  < /path/to/a/file/with/the/address
```

The Compose recipe hasn't been run on the host yet: it needs a host with Docker. Check it there before relying on it.
