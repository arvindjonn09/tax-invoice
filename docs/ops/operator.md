# Operator area

How a platform operator signs in and uses `/operator` (ADR 0004 D2 and D5, #232). The CLI (`pnpm operator …`) can do
every operator task without the screens.

## Before you start

- You need all three keys: an active `platform_operators` row (`pnpm operator grant`), your user id in
  `JOBFLOW_OPERATOR_USER_IDS` on the host, and a verified email address.
- In production, `/operator*`, `/api/operator/*` and `/api/auth/two-factor/*` sit behind Cloudflare Access. Sign in
  to Cloudflare Access with the allowed identity first by opening `/operator`. Anyone else sees Cloudflare's own
  "Access denied" page, which JobFlow can't change. `/login` itself isn't behind Access.

## Set up two-factor authentication (once)

1. On the server, run `pnpm operator enrol-code --user <your user id>`. The code works once, for 10 minutes.
2. Sign in to JobFlow with your password, then open `/operator/mfa`.
3. Enter the enrolment code and your password, scan the QR code (or type the key), and enter the 6-digit code.
4. Save the backup codes. They're shown once.

## Sign in

Enter your email and password on `/login`. JobFlow then asks for the code from your authenticator app, or a backup
code.

If you lose your device, run `pnpm operator enrol-code --user <id> --reset` on the server and set up two-factor again
at `/operator/mfa`. There's no self-service recovery, by design.

## What the screens do

- **Extension requests** (`/operator`): pending requests oldest first, and the latest decisions. Review one to approve
  it (1–365 days, with a private note) or decline it (the owner sees the reason).
- **Companies** (`/operator/companies`): search by name (demo companies are never listed), then extend a trial to a
  date or change between trial and unrestricted. Each change needs a reason.

Every action asks for confirmation, is audited, and emails the company's owners.
