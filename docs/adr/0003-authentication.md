# ADR 0003: Authentication with Better Auth and database sessions

Status: accepted for #13. Date: 23 October 2026.

## Context
#13 needs email + password sign-in with an established library, secure HttpOnly
SameSite cookies, CSRF protection, sign-in throttling and server-side resolution of
the active company. The threat model (T01) also requires session **revocation**, and
the deployment may run more than one app instance.

## Options considered
- **Auth.js (next-auth)**: v4 is in maintenance and v5 is still beta (5.0.0-beta.32).
  Its credentials provider only supports JWT sessions, which can't be revoked
  server-side without extra infrastructure.
- **Better Auth 1.7**: stable, supports Next 16 and Prisma 7, email + password with
  **database sessions**, built-in rate limiting with database storage, origin/Fetch
  Metadata CSRF checks, and a Prisma adapter.
- **Hand-rolled sessions**: rejected; AGENTS.md requires an established library.

## Decision
Use Better Auth 1.7.12 (`apps/web/src/server/auth/`).
- Tables: `auth_sessions`, `auth_accounts`, `auth_verifications`, `auth_rate_limits`,
  plus `users.email_verified` and `users.image` (migration `20261023010000_auth`).
  IDs are PostgreSQL UUIDs.
- Passwords are hashed with Better Auth's scrypt. scrypt is an OWASP-recommended
  password hash alongside argon2id and bcrypt, and it avoids a native dependency.
  Passwords must be 12 to 128 characters.
- **No public sign-up.** Users are created through `createCredentialUser` by owners
  (#27) or the demo seed (#21).
- Sessions last 12 hours (refreshed hourly) and are revoked by deleting the row.
  Cookies are `jobflow.*`: HttpOnly, SameSite=Lax, Path=/, and Secure with the
  `__Secure-` prefix in production.
- CSRF: POSTs must come from `BETTER_AUTH_URL`'s origin. Better Auth disables this
  check when `NODE_ENV=test`, so the config pins `disableOriginCheck` and
  `disableCSRFCheck` to `false`.
- Throttling: 5 sign-in attempts per minute per client IP, stored in the database
  (shared across instances). The UI shows the same generic error for a wrong
  password and an unknown email.
- In production, accounts with `@example.test` (synthetic demo) emails can't sign in.
- `resolveActor()` loads the session **and** active memberships on every request.
  The company and role come from the database, and a remembered company is honoured
  only while its membership is still active.

## Consequences
- Rate limiting keys on the client IP from `x-forwarded-for`. Deployment (#64) must
  put the app behind a proxy that sets this header correctly, and must not let
  clients spoof it.
- Per-account lockout, MFA for privileged users and password reset email are
  follow-ups (#71, #27).
- Better Auth's own tables follow its schema; changes to them need this ADR updated.
