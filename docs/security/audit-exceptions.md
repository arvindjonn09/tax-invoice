# Dependency audit exceptions

## GHSA-vfj7-8cjw-p6xm — temporary development lint-tooling exception

- Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- Package: braces@3.0.3 (high severity, stack exhaustion with deeply nested patterns).
- Current path: eslint-config-next@16.4.2 → @next/eslint-plugin-next@16.4.2 → fast-glob@3.3.1 → micromatch@4.0.8 → braces@3.0.3.
- Scope: development-only ESLint tooling; no application endpoint supplies patterns to it. Malicious repository/config inputs could exhaust the tooling process. This is a narrow accepted risk, not a general claim of package safety.
- Original owner approval: 22 October 2026, PR #69 / issue #8; initially expired on November 21 or #10 closure.
- **Fresh owner approval for #10:** 22 October 2026 in the implementation conversation. The owner selected “Approve this narrow renewal”: retain only this advisory until November 21, removing only the issue-10-closure condition. The same conversation approved the proposed branch protection after CI and exact-head review.
- **Current deadline:** 21 November 2026 at 00:00 Australia/Sydney (`2026-11-20T13:00:00Z`). No issue-closure condition remains. CI fails at the deadline. Further extension requires another explicit owner decision.
- Enforcement: only this GHSA appears in `pnpm.auditConfig.ignoreGhsas`. Full `pnpm audit --audit-level high` remains blocking for every other high/critical finding. The negative audit regression proves an unrelated known vulnerability is rejected.
- Production: no exceptions. `pnpm audit:prod` audits the exact unchanged production lockfile in an isolated workspace copy with every manifest auditConfig removed, and forwards failure status.
- Removal: upgrade/remediate when supported, remove ignoreGhsas and the deadline gate, and verify both full and production audits pass. No production exception is authorized.

## #10 re-review — 22 October 2026

The npm registry still lists braces 3.0.3 and the official GitHub advisory lists
affected versions <=3.0.3 with no patch. Current Next ESLint tooling remains 16.4.2
and requires fast-glob 3.3.1. A supported upstream update does not yet remove this
path. Local full audit reports exactly the one ignored development advisory; the
production audit is clean. No new exception or dependency override was added.

This owner-approved change removes only the issue-10-closure trigger; it does not
change the calendar deadline, advisory list, severity gates or production behavior.
