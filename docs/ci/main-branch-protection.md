# Proposed main branch protection (#10)

**Status: owner approved on 22 October 2026; not yet applied.** Read-only inspection on 22 October 2026 returned
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

The owner approved this exact payload in the implementation conversation. Apply it
only after #10 has green current-head CI and exact-head supervisor approval:

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
