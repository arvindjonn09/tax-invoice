# Subcontractor portal (#37)

`/offers` and `/offers/:id` are subcontractor-only server pages. The detail page
checks company and contractor ownership before rendering; office/employee roles,
invalid IDs and other contractors' offers return 404. `/jobs` uses the accepted-work
portal for subcontractors; the employee/office `/jobs/:id` route stays separate.

`GET /api/my/offers` retains the positive own-offer projection from #35. Optional
`q` searches only the caller's work scope and job reference/title. `status` filters
known offer statuses. `view=jobs` forces accepted status and an active contractor
before counting/paging, so client filtering never determines access or page counts.
`GET /api/my/offers/:id` checks the current subcontractor role, company and linked
contractor and returns the same projection. Job fields are limited to reference,
title, status and due date; customer prices, margins, committed cost, company GST
position and other contractors' information are absent. Own rate/GST/total and
accepted snapshots are allowed. Archived contractors retain offer history with an
inactive flag; accepted work/action controls are removed.

Responses use #35's locked accept/decline API, require confirmation, retain failed
edits and warn on navigation. Accepted terms are read-only. All currency values
are server-calculated integer-cent strings, formatted through existing BigInt
money components. The bill section is an explicit later-release placeholder.

## Evidence integration dependency

The evidence panel uses #42's worker endpoints (`/api/my/work/:jobId/evidence`
and `/submit`) and #34's private document upload/signed-download APIs. It does not
implement another evidence backend. Photo/signature files are limited to 10 MB;
server content sniffing and authorization remain authoritative. A successful
private upload is retained across attachment failure, so retrying does not upload
again or falsely report an attachment. Download links are generated on demand
and expire in five minutes. Work notes are bounded to 2000 characters.

**Do not merge #37 before #42 (PR #125), including its review fixes, is merged and
real evidence integration is verified.** There is no runtime feature stub claiming
success. The portal's evidence component contract test explicitly mocks the pending
attachment API; that test does not prove storage/backend integration.

## Verification

- Contractor API integration tests cover direct-read object/company/role scope,
  redacted responses, accepted-work search/count/paging and archived access.
- Portal browser tests cover confirmed responses, own accepted work, forbidden
  navigation/fetches, response recovery, search/empty/retry, semantic light/dark
  themes, responsive reflow and axe checks.
- The mocked evidence component test covers retaining private upload IDs and note
  text across attachment failure; the upload occurs once while attachment retries.
- A separate real browser workflow (no mocks/skips) uploads/downloads a private photo,
  refuses another uploader’s file, saves a note and submits the job for review. It
  requires #42 plus MinIO and has not run before that dependency lands.
- Real evidence attachment/submission remains a merge gate on #42. No schema,
  dependency or third-party component was added by #37.
