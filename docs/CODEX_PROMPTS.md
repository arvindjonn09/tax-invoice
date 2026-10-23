# Codex prompts

How to hand the remaining JobFlow work (milestones M0–M5) to OpenAI Codex. Codex reads `AGENTS.md` automatically;
these prompts tell it how to work through the GitHub issues. See [plan.md](../plan.md) for the full project plan.

## Before you start
Since 23 October 2026 Claude Code and Codex **both implement**, in parallel, and review each other's PRs; see
AGENTS.md "Who does what" and "Merge policy". Coordination lives on the shared page
`/home/prod/jobflow-updates.md`: the current split of issues and an append-only log. `/home/prod/jobflow-codex-next.md`
is the latest handoff note for Codex. If either disagrees with AGENTS.md, **AGENTS.md wins**.

**Codex CLI on this PC:** `gh` is logged in as `arvindjonn09`, so Codex can claim issues, review and merge itself.
Codex works only in `/home/prod/tax-invoice`.

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
- Claude Code works in parallel. The shared page /home/prod/jobflow-updates.md
  holds the current split of issues and an append-only log. Read it first.
- Take the next issue in YOUR lane of the split that is unclaimed and whose
  "Depends on:" issues are all closed. Never take an issue Claude claimed.
- Keep milestone order: M0 (#2), M1 (#3), M2 (#4), M3 (#5), M4 (#6), M5 (#7).
  Never start a later milestone's backend work early.
- Claim it on the page before any code:
  "<UTC time> · Codex · #<n> · claimed (branch …)"

FOR EACH ISSUE
1. Read the issue and its comments. With the gh CLI, always pass --json, e.g.
   gh issue view <n> --json title,body,labels,milestone,comments
   (plain `gh issue view` fails on older gh versions).
2. If gh is available, claim the issue: add `status:in-progress`, remove `status:ready`.
3. Branch from the latest main: <type>/<issue>-<slug>, e.g. feat/17-money-gst-core.
4. Implement only what is in this issue's scope. Write tests alongside the code.
   Use Conventional Commits that mention the issue: feat(domain): add GST line calc (#17)
5. Run type-check, lint, unit/integration/e2e tests and build (commands are in
   CLAUDE.md). Fix every failure. Never skip or delete a failing test to get a
   green run.
6. Open a PR using .github/pull_request_template.md:
   - "Closes #<n>"
   - a summary
   - a pass/fail checklist of every acceptance criterion in the issue
   - the real command output from your test run
   - known limitations
   - screenshots at 390px and 1440px (light and dark) for any UI change
7. Comment on the issue: what was done, what's left, what comes next.
   Set `status:in-review`, and log the PR on the shared page.
8. Review Claude's open PRs listed on the shared page: one
   "🔎 Codex review (<sha7>)" comment per new head commit (Blocking / Should fix /
   Looks good), then log "reviewed PR #X: ok|changes".

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

MERGING (AGENTS.md "Merge policy" is the authority; it overrides anything else)
- Merge a PR only when: every required check is green on its current head commit;
  the OTHER agent has reviewed that exact head (for your PRs: a
  "🔎 Claude review (<sha7>)" comment saying "Ready to merge"); every review
  conversation is resolved; its dependencies are merged. Use a merge commit.
- Your own review never counts for your own PR.

NEVER
- Merge without the other agent's review of the exact head, bypass checks, or close
  issues except via merged PRs.
- Force-push main, or push to a branch Claude is working on.
- Change the scope of an issue. If you find extra work, open a new issue with
  the right labels and milestone, and link it.
- Implement several issues in one PR, or several modules in one untested change.

When you finish each PR, report: PR link, issue number, test results,
acceptance criteria pass/fail, and the next issue you recommend.
Begin by reading /home/prod/jobflow-updates.md and taking the next eligible
issue in your lane.
```

---

## Prompt 2 — paste for each later issue

```text
Work on issue #<N> in arvindjonn09/tax-invoice. Follow plan.md, AGENTS.md, CLAUDE.md and the
role file .claude/agents/<agent-label>.md. Read /home/prod/jobflow-updates.md first and
append "<UTC time> · Codex · #<N> · claimed (branch …)"; skip the issue if Claude claimed it.
Confirm every "Depends on" issue is closed, then: branch from the latest main, implement
with tests, run type-check, lint, tests and build, and open a PR with "Closes #<N>" and an
acceptance-criteria checklist backed by real test output. Log the PR on the updates page.
Also review Claude's open PRs listed there (one "🔎 Codex review (<sha7>)" comment per new
head). Merge only under the AGENTS.md merge policy (CI green on the exact head, the other
agent's review of that head, all threads resolved), then log the merge.
```

---

## Prompt 3 — fix review feedback on a PR

```text
PR #<P> in arvindjonn09/tax-invoice has review comments. Read them with
gh pr view <P> --json title,body,reviews,comments and gh pr diff <P>.
Fix every Blocking and Should-fix item on the same branch, add tests that would
have caught each bug, rerun type-check, lint, tests and build, push, and reply to
each comment with what changed, and resolve the threads you fixed. Then wait for a new
review of the new commit by the other agent.
```

## Your loop as owner
1. Check `/home/prod/jobflow-updates.md` to see who is doing what and what merged.
2. Agents merge without waiting for you, once the other agent's review and CI are green (AGENTS.md merge policy).
3. Test the preview after merges (http://shiva-1.tail3e0a57.ts.net:3300) and report problems as GitHub issues.
4. Still yours: branch protection, preview design sign-off, security exceptions, accountant sign-off, deploys and costs.
