---
name: work-issue
description: Take one GitHub issue from ready to a reviewed pull request using the right specialist agents. Use when the user says to work on, implement, or fix issue #N.
argument-hint: <issue number>
---

Work issue **#$ARGUMENTS** in `arvindjonn09/tax-invoice`.

1. `gh issue view $ARGUMENTS --json title,body,labels,milestone,comments`. Pick the owner from its `agent:*` label; if none,
   choose the best-fit agent from `CLAUDE.md` and add the label.
2. Dispatch that agent with the issue number and any context it needs. It must follow the
   `CLAUDE.md` workflow (claim → branch → implement + tests → PR with `Closes #$ARGUMENTS`).
3. When a PR exists, run `qa-engineer` and `code-reviewer` on it (in parallel). Add
   `security-engineer` if it touches auth, PII, payments, uploads, or secrets.
4. If reviewers request changes, send the findings back to the owning agent and repeat
   once more; if still failing, stop and report.
5. Report: PR link, CI status (`gh pr checks`), review/QA verdicts, and anything left open.
   Do not merge unless the user asks.
