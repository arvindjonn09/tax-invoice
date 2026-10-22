# Dependency audit exceptions

## GHSA-vfj7-8cjw-p6xm — temporary lint-tooling exception

- Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- Package: braces@3.0.3 (high severity, stack exhaustion with deeply nested patterns).
- Path: eslint-config-next@16.4.2 → @next/eslint-plugin-next@16.4.2 → fast-glob@3.3.1 → micromatch@4.0.8 → braces@3.0.3.
- Scope: development-only ESLint tooling. No application endpoint accepts patterns for this toolchain. Repository code/configuration are its inputs. Exploiting this finding here would require introducing a malicious pattern into that lint input; availability impact is limited to the tooling process. Risk is accepted as negligible in this context, not as a general claim that the package is safe.
- Remediation availability: audit reports no patched release; re-check at review and remove the exception as soon as a fix exists.
- Owner approval: 22 October 2026, explicitly approved in the PR #69 conversation for issue #8.
- Review deadline: 21 November 2026 (Australia/Sydney), or when issue #10 lands, whichever occurs first. Do not extend without a fresh owner decision. CI fails from the start of that date or if #10 is closed, requiring review.
- Enforcement: package.json contains only this GHSA in pnpm.auditConfig.ignoreGhsas, supported by the installed pnpm 9.15.4 implementation. The full `pnpm audit --audit-level high` step remains blocking for all other high/critical findings.
- Production: no exceptions. `pnpm audit:prod` runs `pnpm audit --prod --audit-level high` against an isolated copy of the exact workspace manifests and lockfile, with every manifest's auditConfig removed. This avoids pnpm applying the global development exception to production. The temporary copy is removed even after failure. No dependency versions are modified.
- Removal: upgrade the affected tooling when patched, delete ignoreGhsas and this exception's CI deadline gate, and verify both the full and exception-free production audits pass. Keep this record updated with the resolution.

This exception applies only to the stated development path. The production audit must fail if the same advisory reaches production dependencies.
