# Proposed main branch protection (#10)

**Status: owner approved on 22 October 2026 (with 0 required approvals); not yet applied.** Read-only inspection on 22 October 2026 returned
`404 Branch not protected`. AGENTS.md reserves branch-protection changes to the
owner. The reviewed payload is
[main-branch-protection.proposed.json](../../.github/main-branch-protection.proposed.json).

The payload requires current-branch CI (`verify`, `gate-regressions`, `secrets`,
`static-analysis`, `CodeQL`, `contrast`, `research-contract`) on an up-to-date branch,
a pull request for every change to `main` (`required_pull_request_reviews` with
**0 required approvals**), dismissed stale reviews and resolved conversations. It
applies to admins, forbids deletion and force-push, and permits merge commits. No
exception or bypass is proposed.

**Why 0 approvals (owner decision on #10, 22 October 2026):** `arvindjonn09` is the
only collaborator and every agent (Codex, Claude) acts through that account. GitHub
never lets a PR's author approve it, so a required approval with admins enforced
would block every merge. The review gate is the AGENTS.md merge policy instead: an
exact-head supervisor review comment saying "Ready to merge", plus the required
checks above.

Apply it only after #10 has green current-head CI and an exact-head review:

```sh
gh api repos/arvindjonn09/tax-invoice/branches/main/protection \
  --method PUT --input .github/main-branch-protection.proposed.json

gh api repos/arvindjonn09/tax-invoice/branches/main/protection
```

Check the returned settings and actual required contexts. If GitHub rejects a
setting or reports a plan/permission limitation, report it; do not silently weaken
requirements. The file is a proposal, not an automatic setup or deployment step.

The owner also approved retaining the sole development lint-tool advisory until
November 21, removing only the previous issue-10-closure expiry. The workflow and
exception record now implement that decision; production audits remain exception-free.
