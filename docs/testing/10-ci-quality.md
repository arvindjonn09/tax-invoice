# CI quality and security gates (#10)

All PRs and pushes to main run the workflow checks. Dependency installation uses
the frozen lockfile and pnpm cache. `verify` starts actual PostgreSQL and MinIO,
waits for readiness, deploys migrations twice, exercises the guarded disposable
reset, then runs type checking, lint, formatting, unit/integration tests, build,
browser tests and audits. The other required jobs scan all fetched Git history,
run CodeQL and reject SARIF findings, and check design/domain contracts.

Every action is pinned to a full upstream commit SHA; Dependabot proposes weekly
npm workspace and Actions updates. Prisma and Next toolchain updates are grouped
for compatible review. Workflow defaults grant only contents:read; CodeQL alone
grants security-events:write, and no job needs issues:read after the owner-approved exception review. Checkout credentials are not persisted. No workflow uses
pull_request_target or accepts arbitrary code with a privileged repository token.

`gate-regressions` invokes `scripts/ci/prove-gates.mjs`. It copies tracked source to
a disposable directory and runs actual commands with deliberately invalid inputs:

```text
TypeScript: rejected intended fixture (exit 2)
ESLint: rejected intended fixture (exit 1)
Vitest: rejected intended fixture (exit 1)
Dependency audit: rejected intended fixture (exit 1)
Gitleaks: rejected intended fixture (exit 1)
All five actual quality/security commands rejected their negative fixtures.
```

The vulnerable lodash fixture creates only a lockfile; it installs/executes no
vulnerable code. Its directory is outside the copied workspace so pnpm cannot
silently audit the parent. The scanner fixture is an obviously fake AWS-format
access ID, committed only in a disposable local Git repository and never pushed.
No valid credential, broken source or vulnerable package is added to the project.
The assertions require the intended diagnostic as well as nonzero exit status,
and cleanup runs on failure. Logs redact scanner output. Audit registry availability
is required: the probe parses audit JSON and requires a high/critical lodash advisory;
a network failure does not count as proof of a vulnerability rejection.

This demonstrates the blocking commands in a PR CI job. The server-side merge
restriction still requires the owner-approved branch protection proposal to be
applied; green configuration files alone cannot prevent an unprotected-branch merge.

Locally run with Node 24.21.0/pnpm 9.15.4 and gitleaks 8.30.1:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
GITLEAKS_BIN=/path/to/gitleaks node scripts/ci/prove-gates.mjs
```

All five fault probes passed on 22 October 2026. This host has no Docker; actual
Compose startup and CodeQL execution are validated by the PR's CI, not claimed
locally. Native PostgreSQL is available for local integration checks.

The pre-existing `braces` development-only exception was reviewed again. The owner
approved retaining only that advisory until November 21 and removing only the
issue-10-closure condition; see the [exception record](../security/audit-exceptions.md).
The owner approved the exact branch-protection proposal as well; apply it only
after green CI and exact-head supervisor approval, then verify the API settings.

MinIO currently rebuilds its pinned source in CI. BuildKit registry/GHA caching
needs a separate reviewed implementation (#34), including cache permissions and
untrusted-PR behavior; pin/health/test gates must remain intact.
