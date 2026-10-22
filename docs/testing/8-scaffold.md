# Issue #8 validation

Local environment: Node 24.21.0, pnpm 9.15.4, Linux.

- Install: passed. pnpm-lock.yaml committed for reproducible installs.
- `pnpm typecheck`: passed for root and all five workspace packages.
- `pnpm lint`: passed, zero warnings.
- `pnpm format:check`: passed.
- `pnpm test`: one strict-configuration test passed.
- `pnpm test:integration`: one route-contract test passed. This is not database integration coverage.
- `pnpm build`: passed; home and /api/health routes generated.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- `pnpm audit --audit-level high`: blocked by GHSA-vfj7-8cjw-p6xm in braces 3.0.3, through eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch. Registry currently offers no patched braces release. The CI gate remains enabled; no exception or suppression added.
- `pnpm test:e2e`: **12 passed against development (7.7s) and production (2.8s) builds** in local Chromium after extracting Ubuntu browser libraries into /tmp/jobflow-browser-libs (no system package installation). The original smoke test also passed in GitHub Actions run 39768121004. CI installs system dependencies with Playwright's --with-deps option.

## Review status and limitations

The scaffold is implemented, but #8 is not complete until the security audit and independent review pass. No database, auth, demo records, financial functionality or design preview is included. Database migration and seeding commands are explicitly marked unavailable until their issues land. Full security automation and branch protection remain #10; no production deployment or protection changes were made.

The working tree initially contained owner documentation edits. A concurrent owner documentation commit appeared during implementation; those files and commits were preserved. The scaffold branch was not rebased over or reset against that work.


## Browser and functionality audit — 22 October 2026

Ran Chromium against both the local Next.js development server and a fresh production build served with next start. Tested 360, 390, 768, 1024 and 1440px at 900px height, in both light and dark themes. All ten layouts rendered without horizontal overflow or uncaught page errors. Checked the page title, document language, implementation notice, health response and cache header, and unknown-path 404 behavior. This is scaffold coverage, not a complete WCAG audit or business-workflow acceptance test. There are no business controls to exercise or keyboard workflows to verify yet.

Screenshots reviewed: [mobile light](screenshots/home-390-light.png), [mobile dark](screenshots/home-390-dark.png), [desktop light](screenshots/home-1440-light.png), [desktop dark](screenshots/home-1440-dark.png). All ten captures are attached to the generated Playwright HTML report. CI retains that report as a build artifact.

### Actual functionality

| Area | Observed result | Planned delivery |
|---|---|---|
| Home `/` | 200; static placeholder and implementation notice | #8 scaffold |
| `/api/health` | 200; minimal liveness JSON, no-store | #8 scaffold |
| Login `/login` | 404; authentication, sessions and role checks absent | Remaining M0 |
| `/dashboard` | 404; preview and real dashboard absent | M0 preview, M4 real |
| `/customers`, `/jobs`, `/employees`, `/settings` | All 404; customer/job records and company/GST/user settings absent | M1 |
| `/contractors`, `/expenses` | Both 404; offers, expenses, timesheets and private documents absent | M2 |
| `/quotes`, `/invoices`, `/payments` | All 404; quotes, invoices/PDFs, bills, receipts and allocations absent | M3 |
| `/reports` | 404; profit, ageing and draft GST/BAS reporting absent | M4 |

The database, tenancy, audit/idempotency schema, GST/profit core, design system, app shell/navigation, synthetic database demo data and design previews are also still absent from M0. The persistent Demo Data indicator is required when demo records are introduced; none exist now. The reserved packages currently contain no implementation.

**Finding:** issue #8's placeholder works. The planned product remains unimplemented beyond its scaffold; a successful browser smoke test does not establish financial correctness, security or usable business functionality. Continue in milestone/dependency order, beginning with the PostgreSQL/Prisma foundation after #8 review, alongside dependency-free M0 tasks. Do not add invoice/dashboard financial functionality ahead of its data modules.

**Release blocker:** GitHub Actions run 39768121004 passed install, typecheck, lint, formatting, unit/integration tests, build and the original browser test. Its final dependency audit failed on the braces advisory above. No audit suppression has been applied.
