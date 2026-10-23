# User access and invitations (#27)

Owner-only administration is available at `/users` and `/api/users`. The existing
`user.manage` permission protects reads and writes, even though managers retain
`user.read` for future operational lookup. Company scope comes from the session.
Memberships are never deleted. Role and active-status changes are audited in the
same transaction, including the immediate previous state. Unchanged requests return
the locked current row without updating timestamps, revoking sessions or writing
audit events.

All membership and invitation writes lock the company row before reading state,
then re-check the acting owner's current membership. This serializes concurrent
owner demotions/deactivations and prevents a queued request by a demoted owner
from granting access. At least one active owner must remain. Deactivation deletes
sessions for this company and sessions without a remembered company; when the
user has no active memberships, it deletes all their sessions. Other companies'
explicitly selected sessions remain valid. Authentication refuses new sessions
for users who have memberships but none active. The existing per-request actor
resolution remains authoritative for role changes and concurrent access removal.
A never-member account can sign in to accept an invitation but has no company
access until acceptance.

## Invitation contract

- Owner issues email + one of the five existing roles. The server generates a
  random 256-bit token, persists only its SHA-256 digest, and returns a relative
  `/invite#<token>` link once. The client constructs the URL using its own origin.
- The owner copies and shares the link privately with the intended recipient.
  **No email transport is configured and no email is sent automatically.**
  Possession of the invitation link authorizes new-account creation, so the owner
  must treat it as a credential. Tokens are never put in query parameters,
  persisted in browser storage, logged or included in audit metadata.
- Invitations expire after 48 hours, are single-use and can be revoked by an
  owner. A replacement requires revoking a live invitation first; expired ones
  are revoked and audited automatically when replaced. Pending invitations are
  unique per email/company. Lists exclude consumed/revoked invitations and never
  return token digests. The UI paginates pending invitations in pages of 100, so
  every outstanding invitation stays discoverable and revocable.
- Acceptance POST is the documented public exception to the usual session policy.
  It enforces trusted origin, a streaming 4 KiB JSON limit, shared database IP
  throttling, token validity/expiry and a still-active owner inviter. It locks the
  company row like every administrative write and consumes the invitation with
  the new membership and audit event in one transaction. Failed acceptance leaves
  neither an account nor a membership behind.
- A new user supplies name and a 12–128-character password, hashed using the
  established Better Auth helper. An existing email requires a signed-in session
  for that exact account; a token never resets someone else's password. Existing
  memberships, including inactive ones, require explicit owner access editing
  rather than invitation-based reactivation. Concurrent new accounts across
  companies receive a safe conflict and can retry after signing in.
- The grant audit attributes authorization to the inviting owner and records the
  recipient user and new membership IDs. Tokens, passwords and email values are
  absent or redacted. New accounts sign in through Better Auth after acceptance.

## API

| Operation | Endpoint | Permission |
| --- | --- | --- |
| Search/page memberships and pending invites | `GET /api/users?q=&page=&pageSize=&invitationPage=` | `user.manage` |
| Set role and/or active status | `PATCH /api/users/[membershipId]` | `user.manage` |
| Create invitation | `POST /api/users/invitations` | `user.manage` |
| Revoke invitation | `DELETE /api/users/invitations/[id]` | `user.manage` |
| Redeem invitation | `POST /api/invitations/accept` | One-use token; matching session for existing email |

All JSON responses are private/no-store. CSRF checks precede authentication;
request IDs and client-supplied company/role overrides never grant permissions.
Invalid input returns 400, unauthorized roles 403, cross-company IDs 404, unsafe
owner changes or duplicate memberships/invitations 409, and throttled requests 429.
An existing account without a matching acceptance session receives 401.

## Verification and limits

`tests/integration/users.test.ts` covers all roles, tenants, last-owner races,
current permission checks, deactivation/sign-in/session revocation, safe audit
metadata, invitation replay/races, existing-account protection, expiry/revocation,
CSRF, input/body limits and acceptance throttling. Migration tests prove the
invitation DDL can be reversed and reapplied on an empty disposable database.
Browser coverage exercises invite → join → change role → deactivate, denied
employee access, empty/error/retry states and keyboard/axe checks with mobile and
desktop captures in light/dark themes. `pnpm test:e2e` now uses a migrated,
disposable database using main’s shared runner and global isolation guard, never
the development database.

Privileged MFA and automated email delivery are not enabled. This implementation
adds no password-reset mail service; the existing sign-in minimum password length,
CSRF and throttling remain in place. These limits must be reviewed before pilot;
this issue does not claim production security sign-off.
