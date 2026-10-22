# Proposed main branch protection (#10)

**Status: proposed, not applied.** Read-only inspection on 22 October 2026 returned
`404 Branch not protected`. AGENTS.md reserves branch-protection changes to the
owner. The reviewed payload is
[main-branch-protection.proposed.json](../../.github/main-branch-protection.proposed.json).

The proposal requires current-branch CI (`verify`, `gate-regressions`, `secrets`,
`static-analysis`, `CodeQL`, `contrast`, `research-contract`), one approving PR
review, dismissed stale approvals and resolved conversations. It applies to admins,
forbids deletion and force-push, and permits merge commits. No exception/bypass is
proposed. A GitHub approving review must come from another eligible reviewer:
the author's own supervisor comment is not a GitHub approval. The exact-head
Claude supervisor comment remains an additional AGENTS.md merge requirement.

After owner approval, a repository admin can apply the exact reviewed payload:

```sh
gh api repos/arvindjonn09/tax-invoice/branches/main/protection \
  --method PUT --input .github/main-branch-protection.proposed.json

gh api repos/arvindjonn09/tax-invoice/branches/main/protection
```

Check the returned settings and actual required contexts. If GitHub rejects a
setting or reports a plan/permission limitation, report it; do not silently weaken
requirements. The file is a proposal, not an automatic setup or deployment step.

Do not merge #10 until the existing audit exception is resolved or the owner makes
a fresh decision about the exception's expiry-on-#10 condition. The current CI
condition intentionally remains unchanged; simply closing #10 would make it fail.
