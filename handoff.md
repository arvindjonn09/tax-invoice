# Handoff: Claude B → Claude A (5 November 2026, 19:10 Sydney)

Claude B (cloud session `claude-cloud-9751`) is pausing. This lists every open item Claude B owned, its exact state,
and what's left, so Claude A can pick any of them up. All of Claude B's branches are pushed and clean; nothing is
uncommitted.

**Carrying on Claude B's work.** AGENTS.md says never push to the other agent's branch. Two ways to work on these
PRs instead:

- **(a)** Carry it on your own branch with a superseding PR, as #241 did for #238.
- **(b)** Leave the PR for Claude B to resume.

If you go with (a), the merge-policy review still has to come from an agent that didn't write the commits.

## 0. Update, 5 November 2026, about 20:45 Sydney (supersedes sections 1–2 where they differ)

Claude B worked through #265, #266, #249 and #250 in that order:

| PR                  | New head               | State                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #265 (spec)         | `f039190`              | Every finding from Claude A's 78bca44 review is fixed (table on the PR), and both Codex threads are resolved. **Waiting for Claude A's re-review.**                                                                                                                                             |
| #266 (email pacing) | `e2008c5`              | Every finding from the 850e85a review is fixed (table on the PR). It adds migration `20261105120000_email_pacing` and the once-a-minute sweep in `instrumentation.ts`. The Codex thread is resolved. **Waiting for Claude A's re-review.** The per-row throttling cap (8) is an owner decision. |
| #249                | `5f23c56` (Claude A's) | Claude B re-reviewed this head: **Ready to merge**, with 2 non-blocking notes.                                                                                                                                                                                                                  |
| #250                | `7579c49` (Claude A's) | Claude B re-reviewed this head: **Ready to merge** after #249, with 1 non-blocking note.                                                                                                                                                                                                        |

Still open for Claude B: #261 (section 2.3), #264, #65, #263 and #260.

## 1. State at handoff

| PR   | Branch @ head                                     | Issue                                   | State                                                                                                                                       | Needs                                            |
| ---- | ------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| #265 | `docs/208-signup-trial-ux` @ `78bca44`            | #208 (P0, blocks #223–#226, #228, #232) | Changes requested by Claude A at 78bca44. 2 unresolved Codex threads (`:235`, `:271`). CI green                                             | Section 2.1                                      |
| #266 | `feat/259-email-pacing` @ `850e85a`               | #259                                    | Changes requested at 850e85a. 1 unresolved Codex thread. CI green                                                                           | Section 2.2                                      |
| #261 | `feat/136-malware-scan` @ `dadfb57`               | #136                                    | Changes requested at dadfb57. 0 open threads. CI green. **Owner decision needed** on how clamd runs on the live host, and on encrypted PDFs | Section 2.3                                      |
| #249 | `feat/217-signup-api` @ `5f23c56` (Claude A's)    | #217, #218                              | Claude A fixed Claude B's review and asked for a **re-review of 5f23c56**                                                                   | Claude B's re-review, or another independent one |
| #250 | `feat/220-onboarding` @ `7579c49` (Claude A's)    | #220                                    | Claude A is fixing Claude B's review                                                                                                        | Re-review when posted                            |
| #254 | `feat/252-admin-console` @ `8cfd1f4` (Claude A's) | #252                                    | **Waiting on the owner:** Claude B's High finding (no TOTP, no Access, one shared password), options a, b or c                              | Owner decision                                   |
| #264 | Claude A's threat model @ `a20e44c`               | #207                                    | Not yet reviewed by Claude B                                                                                                                | Independent review                               |

Merged today: #239, #243, #255, #256, #257 and #262.

## 2. What's left on each of Claude B's PRs

### 2.1 #265: sign-up, trial and operator UX spec (`docs/design/signup-trial.md`)

This is the top priority. It unblocks all the M6 UI issues. Claude A's review at 78bca44:

1. **P1, chooser (`:235`):** only owner, manager and accountant rows show trial text. Workers see "Read-only" when the
   company is read-only, and nothing otherwise (S8 AC2). Answer Codex thread `:271` too: extension history is
   owner-only.
2. **Verify page (§3):** switch to the **"Confirm my email" button**, which #249 now builds; the token is spent only
   on press. Add pre-click, pending, invalid and already-verified states, and list the S3 AC2 difference.
3. **Check-email (§2):** "navigation state" doesn't exist in the App Router. Name the real mechanism, and specify the
   reload and missing-email states and the "send it again" target. Reconcile the S2 AC1 wording and the route and h1
   with what #250 builds, or list them as deviations.
4. **Operator TOTP challenge:** a 6-digit code screen on `/login`, a backup-code path, error and throttle states, lost
   device, and Access denied (ADR D5). Fix the command to `pnpm operator enrol-code --user <id>`.
5. **Add S10 AC3:** the one-time threshold notices (7, 3, 1 and ended), with copy, dismissal and the `user_notices`
   key.
6. **P3 items:**
   - **Turnstile fallback copy:** use `SUPPORT_EMAIL`, don't promise account setup, and note that focus can't move into
     the cross-origin iframe.
   - **Things the contract doesn't have:** remove the `reference` field, and remove or justify the daily-cap message.
     Confirm what Better Auth's sign-in throttle returns.
   - **Onboarding:** required-field errors for business name, GST yes/no and basis, and the basis default.
   - **`/settings/trial`:** what workers see, the manager "Request more time" text with no action, the exact critical
     copy, and `closed` among the outcome values.
   - **D6:** the approval note is hidden from owners, and there's a "JobFlow operator" audit label.
   - **Mermaid:** the `OB[/onboarding/ step 1]` and `VE[/verify-email#token/]` node labels probably don't parse. Render
     the diagram with `mmdc` to check.
   - **Differences table:** it cites #250-branch strings as if they were on `main`, and it omits #249's verify-pending
     h1.

**Then:** #226 trial banners, which reuse `TrialBanner` from #250.

### 2.2 #266: email pacing (#259)

Claude A's review at 850e85a:

1. **High: one row can stall the queue.** A persistent 4xx uses no attempt, every row moves to the same `until`, and
   the UUID tie-break re-picks the same row.
   - Put the refused row behind the others.
   - Cap rate-limit hits per row, or by age. Capping it refines "never `failed`", so **ask the owner**.
   - Use real exponential backoff instead of a flat 15 minutes.
   - Log at `error`, because ADR D7 says the dispatcher alerts.
   - Make the 554 match narrow, with word boundaries. Today "corporate policy", "Content moderated" and "generate NDR"
     all count as throttling.
2. **The pause doesn't hold.** Rows enqueued during a pause are due at once, and stale `sending` rows ignore it.
   **Fix:** a one-row pause table, checked inside the `claimOne` advisory lock. Test enqueue-during-pause. This also
   resolves the open Codex thread.
3. **Zoho's block reply isn't recognised:** `554 5.1.8 Email Outgoing Blocked`. Treat `5.1.8` and block phrases as
   throttling, with an operator alert.
4. **Failed sends don't count toward the cap.** Count attempts, for example with a `last_attempt_at` column (needs a
   migration).
5. **Paced mail has no timer.** Add a periodic sweep, or make #234 an explicit gate before public sign-up.
6. **Should fix:**
   - **CLI address on screen:** the `pnpm email` wrapper echoes the arguments, so `--address` appears on screen. Read
     the address from stdin or a prompt instead, and test the real `pnpm email` command, not `pnpm exec tsx`.
   - **`docs/ops/email.md`:** add how to run it on the compose host, where Postgres has no published port.
   - **Audit row:** record who ran the CLI.
   - **`ACCOUNT_EMAIL_KINDS`:** use the constant in the SQL, or test that the two stay in sync.
   - **`EMAIL_MAX_PER_HOUR`:** `EMAIL_MAX_PER_HOUR=0` silently means 40; refuse or warn. Add the variable to
     `infra/staging/env/web.env.example`.
   - **From #239** (merged): once pacing ships, update ADR 0004 `:308` and `email-provider.md:55-56`, and fix
     `0004:298` ("per day").

### 2.3 #261: ClamAV upload scanning (#136)

Claude A's review at dadfb57. The digest is from Claude A:
`clamav/clamav:1.4@sha256:8ad6197396974726c35d017e50aaaaf4b91745726a04faec8480c203edd98052`.

1. **Pin the digest in `compose.yml`.** Then remove `CLAMAV_IMAGE` and its gate in `deploy.sh` (exit 66), plus the
   test exemption, the `compose.env.example` line and the staging-config test lines.
2. **High: don't honour `MALWARE_SCAN=off` on built apps.** Add `&& env.NODE_ENV !== "production"` to `disabled` in
   `scanner.ts`. Then fix `malware-scanner.test.ts:189-202` and `preprod-audit.md`, which offers that switch as the
   alternative.
3. **High: live-host deploy order.** The live site runs under `jobflow.service` outside Docker, so `CLAMAV_HOST=clamav`
   can't resolve there. Document a loopback clamd option (`127.0.0.1:3310`). **The owner decides** how clamd runs. Don't
   merge expecting a deploy.
4. **Medium: a dead clamd never recovers.** The upstream entrypoint backgrounds clamd. Run `clamd --foreground` as the
   container command, with `freshclam` as a separate service on the shared `clamav_db` volume.
5. **Medium: the EICAR acceptance test can't pass.** Raw EICAR gets 415 from `sniffType` before the scan. Make the fake
   clamd match exact EICAR bytes, not a substring. Add a CI job using the pinned image:
   - direct INSTREAM of raw EICAR;
   - a well-formed PDF that embeds EICAR;
   - a low `StreamMaxLength`;
   - real scanned invoices, which checks that `MaxFileSize 12M` and `MaxScanSize 50M` with `AlertExceedsMax yes`
     don't refuse them.
6. **Medium: `clamd.conf` edits don't roll out.** Add a config-hash label, or use force-recreate, and test it.
7. **Medium: encrypted PDFs.** The owner has been asked. Until they answer, record it as a known gap, align
   `preprod-audit.md` and `threat-model.md`, and fix the `handlers.ts` "couldn't be checked" message. Today it suggests
   an unprotected PDF, but only over-limit files are refused.
8. **Should fix:**
   - Size `tmpfs /tmp` at about 256m. It counts against `mem_limit`.
   - Add a body-read deadline, and release the scan slot right after the scan, before `store.put`.
   - **Docs:** `off` isn't "ignored with a warning" (no warning exists for that case). `staging.md:53` and
     `deployment.md:73` still describe readiness as database and storage only.

## 3. Other open items Claude A assigned to Claude B (not started)

- **#65, smoke run:**
  1. #262 is merged, so dispatch _Actions → Staging smoke test_ and record the result on #65.
  2. The signed-in part needs the owner to create the `staging` GitHub Environment (main only) with `SMOKE_EMAIL` and
     `SMOKE_PASSWORD`. Steps are in `docs/ops/staging.md`.
  3. Until then, run with **"Fail if the signed-in workflow can't run" unticked** and report signed-in as SKIPPED.
  4. Note that `main` beyond ce136b3 isn't deployed.
  5. Close #65 only after a recorded run.
- **#264:** review Claude A's threat model at `a20e44c`.
- **#263** (P1, ready, unclaimed): invitation accept reveals whether an email has an account.
- **#260:** container hardening, plus the non-blocking items from Claude A's reviews of #255 and #257. Now unblocked.
- **#227 → #229 and #230 → #231 → #233:** as their dependencies land.

## 4. Owner decisions outstanding

1. **#254:** turn `/admin-console` off in production, move it under `/operator` (TOTP and Access), or put both paths
   behind Cloudflare Access.
2. **#261, encrypted or password-protected PDFs:** refuse them, which sets the `AlertEncrypted*` options to `yes`, or
   accept them as a documented gap.
3. **#261, live host:** how clamd runs next to `jobflow.service` (loopback container or package). Until it does, uploads
   return 503 once #261 deploys.
4. **#266:** may a row that keeps getting rate-limited eventually be marked `failed`, after N hits or a set age?
5. **#65:** create the `staging` GitHub Environment and its smoke secrets.

## 5. Working notes

- **Local setup:** each PR has its own worktree under `/home/claude/wt-<issue>`. On a fresh clone:
  `pnpm install --frozen-lockfile`, then `pnpm db:generate`, and have Postgres running for `pnpm test:integration`.
  `pnpm test` reported 484 passed on #266 and 507 passed on #261.
- **Claude B can't reach:** Docker Hub, docker.sock or the live site. The real-clamd and staging checks need a host
  with Docker.
- **GitHub CLI:** GraphQL is blocked, so use REST:
  - create PRs with `gh api repos/arvindjonn09/tax-invoice/pulls`;
  - manage review threads under `pulls/{n}/ccr/review_threads` and `pulls/{n}/ccr/comments/{id}/resolve`;
  - set labels with `issues/{n}/labels`.
- **Comments:** start every one with `[session: Claude A]` or `[session: Claude B / …]`. Both agents share one GitHub
  account.
