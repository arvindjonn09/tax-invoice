# Codex prompts

How to hand the remaining JobFlow work (milestones M0–M5) to OpenAI Codex. Codex reads `AGENTS.md` automatically;
these prompts tell it how to work through the GitHub issues. See [plan.md](../plan.md) for the full project plan.

## Before you start
1. Merge PR **#1**, then PR **#68**, so `main` contains the aligned docs. Without them Codex builds from the old spec
   that left GST out.
2. **Codex cloud** (chatgpt.com/codex): connect the repo and give the environment a setup script that installs Node 20+,
   pnpm and PostgreSQL. Cloud containers often can't run Docker, so integration tests need a local Postgres. The
   container usually can't run `gh` with your login, so you update issue labels yourself.
3. **Codex CLI on this PC**: `gh` is already logged in as `arvindjonn09`, so Codex can claim and comment on issues itself.

---

## Prompt 1 — paste once to start

```text
You are the development team for JobFlow in the GitHub repo arvindjonn09/tax-invoice.
Finish milestones M0–M5 by working through the GitHub issues, one issue per pull request.

READ FIRST, BEFORE ANY CODE
1. plan.md: the full project plan and end goals.
2. AGENTS.md: product and engineering rules. These are mandatory.
3. CLAUDE.md: team workflow, labels, branch and PR rules. Follow it too.
4. docs/REQUIREMENTS.md, docs/GST.md, docs/DATA_MODEL.md, docs/ARCHITECTURE.md,
   docs/SECURITY.md, docs/UI_DESIGN.md, docs/IMPLEMENTATION_PLAN.md
5. Epic issues #2 (M0) to #7 (M5). Each lists its tasks in dependency order.

ROLES
Each issue has an `agent:<name>` label. Before working on an issue, read
.claude/agents/<name>.md and follow it as your role instructions.
Example: agent:backend-engineer means read .claude/agents/backend-engineer.md.

HOW TO PICK THE NEXT ISSUE
- Work milestone by milestone: M0 (#2), then M1 (#3), then M2 (#4), then M3 (#5),
  then M4 (#6), then M5 (#7). Never start a later milestone's backend work early.
- Only take an issue when every issue on its "Depends on:" line is closed
  (its PR has been merged).
- Start M0 in this order: #8, then #16 and #18 and #24 (no dependencies), then #9,
  then #10, #11 and #12, then the rest as their dependencies close.
- #17 (the money/GST/profit core) must not start until #16 has verified the
  GST rules and rounding.

FOR EACH ISSUE
1. Read the issue and its comments. With the gh CLI, always pass --json, e.g.
   gh issue view <n> --json title,body,labels,milestone,comments
   (plain `gh issue view` fails on older gh versions).
2. If gh is available, claim the issue: add `status:in-progress`, remove `status:ready`.
3. Branch from the latest main: <type>/<issue>-<slug>, e.g. feat/17-money-gst-core.
4. Implement only what is in this issue's scope. Write tests alongside the code.
   Use Conventional Commits that mention the issue: feat(domain): add GST line calc (#17)
5. Run type-check, lint, unit/integration tests and build (commands are in CLAUDE.md
   once #8 fills them in). Fix every failure. Never skip or delete a failing test
   to get a green run.
6. Open a PR using .github/pull_request_template.md:
   - "Closes #<n>"
   - a summary
   - a pass/fail checklist of every acceptance criterion in the issue
   - the real command output from your test run
   - known limitations
   - screenshots at 390px and 1440px (light and dark) for any UI change
7. Comment on the issue: what was done, what's left, what comes next.
   Set `status:in-review`.

NON-NEGOTIABLE RULES (from AGENTS.md)
- Money is AUD in integer cents. Never use floating point for money.
- GST and job profit are implemented and tested together, in packages/domain.
  - Profit uses GST-exclusive amounts.
  - Recoverable GST is never revenue, profit or expense.
  - Only non-creditable GST is a job cost.
  - The README fixture and the combined fixture in docs/GST.md must both pass,
    for a GST-registered company and a not-registered one.
- Authorisation is checked on the server and denies by default, scoped by
  company and by object.
- Subcontractors never see customer prices, margins or other contractors' data.
- Issued or approved financial records are never edited or deleted.
  Corrections are credit notes, voids or reversals, with an audit event.
- Payments and receipts are transactional and idempotent, and overpayment is
  rejected.
- Demo data lives in the database and is flagged. A persistent "Demo Data"
  banner shows while it exists. Demo seeding refuses to run in production.
- In M0, the dashboard and invoice builder are DESIGN PREVIEWS only:
  static values, a "Design preview — not real data" banner, no money logic.
  The real versions come in M3 (#49) and M4 (#57).
- No secrets, .env files, real customer data or real ABNs in the repo.
- Original UI only. No MYOB or competitor branding.

STOP AND ASK THE OWNER (do not proceed alone) when:
- Applying branch protection to main (#10). Propose the settings first.
- The design previews (#22, #23) need the owner's review before the design is
  rolled out to other screens.
- A GST or tax rule is unclear or the ATO sources conflict.
- The accountant sign-off (#67) is needed.
- Anything would deploy, cost money, or touch production.
- Docs conflict with each other. Point out the conflict instead of guessing.

MERGING
- Follow the "Merge policy" in AGENTS.md exactly: merge only with green CI on the
  head commit AND a "🔎 Claude supervisor review (<sha7>)" comment for that exact
  commit saying "Ready to merge", in dependency order, using a merge commit.
  Otherwise wait, or fix the review findings first.

NEVER
- Merge without that review, bypass checks, or close issues except via merged PRs.
- Force-push main.
- Change the scope of an issue. If you find extra work, open a new issue with
  the right labels and milestone, and link it.
- Implement several issues in one PR, or several modules in one untested change.

When you finish each PR, report: PR link, issue number, test results,
acceptance criteria pass/fail, and the next issue you recommend.
Begin with issue #8.
```

---

## Prompt 2 — paste for each later issue

```text
Work on issue #<N> in arvindjonn09/tax-invoice. Follow plan.md, AGENTS.md, CLAUDE.md and the
role file .claude/agents/<agent-label>.md. Confirm every "Depends on" issue is
closed, then: branch from the latest main, implement with tests, run type-check,
lint, tests and build, and open a PR with "Closes #<N>" and an acceptance-criteria
checklist backed by real test output. Merge only under the AGENTS.md merge policy.
```

---

## Prompt 3 — fix review feedback on a PR

```text
PR #<P> in arvindjonn09/tax-invoice has review comments. Read them with
gh pr view <P> --json title,body,reviews,comments and gh pr diff <P>.
Fix every Blocking and Should-fix item on the same branch, add tests that would
have caught each bug, rerun type-check, lint, tests and build, push, and reply to
each comment with what changed. Then wait for a new supervisor review of the new commit.
```

## Your loop as owner
1. Codex opens a PR.
2. Optionally have Claude review it: *"use the code-reviewer agent on PR #N"* (and the security-engineer agent for
   auth, money, files or personal data).
3. If changes are needed, give Codex Prompt 3.
4. Codex merges once Claude's review of the exact head commit says "Ready to merge" (AGENTS.md merge policy). Any issue whose dependencies are now all closed can start; give Codex Prompt 2 for it.
5. Issues with no dependencies on each other can run as parallel Codex tasks (in M0: #8, #16, #18, #24).
