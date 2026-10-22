# Issue #19: design-system verification

## Public component contracts

- `MoneyDisplay`: `cents: number | bigint`, required `basis: "ex GST" | "incl GST"`, optional `className`. Instead of cents, pass `unavailable: true` for missing values. Zero remains `$0.00 AUD`. Unsafe/fractional/non-finite numbers throw; BigInt integer arithmetic formats cents without converting to a decimal float. This component does not compute GST, profit or any financial totals.
- `StatusPill`: `status: draft | active | completed | paid | pending | overdue | void`, optional contextual `label`, decorative `icon`, `className`. Default written labels and icons are supplied; paid is settlement only.
- `Button`: shadcn/Radix composition with default, outline, secondary and destructive variants; native button props and optional `asChild`. Disabled text uses contrast-tested muted tokens, with no text opacity.
- `ThemeProvider` wraps the root; `ThemeToggle` is a labelled native select with light/dark/system options. Default is light. `next-themes` persists the choice under `theme` and runs its pre-paint script; explicit system follows OS changes. Storage denial still allows changing theme for the current page.
- `/design-system` is an unlinked component sample route, clearly labelled **Design preview — not real data**. It has no database writes, calculations or real financial actions. The homepage remains the foundation scaffold; the shell and business previews belong to #20/#23.

## Executed locally

Node 24.21.0, pnpm 9.15.4, Linux; no Docker on this machine.

| Command | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Lockfile up to date, successful installation |
| `pnpm typecheck` | Prisma generation, strict configuration guard and all workspace checks passed |
| `pnpm lint` | Passed, zero warnings |
| `pnpm test` | 6 files, 53 tests passed (24 new component/formatter assertions) |
| `pnpm test:integration` | 3 files, 4 tests passed against native PostgreSQL 16 using a unique disposable migrated database |
| `pnpm build` | Passed; `/`, `/design-system` and not-found static; health dynamic |
| `JOBFLOW_E2E_PORT=3191 pnpm test:e2e --workers=2` | 26 browser tests passed, including 14 new design-system tests |
| `python3 scripts/check-design-contrast.py` | 26 token foreground/background pairs passed and matched documented ratios |
| `pnpm audit:prod` | No known vulnerabilities, no production exceptions |
| `pnpm audit --audit-level high` | Only the existing approved development exception, no new findings |

Browser checks assert the actual CSS token values in both themes and run axe WCAG A/AA checks at 360, 390, 768, 1024 and 1440px. All rendered scans had zero violations. They cover explicit light default even with dark OS, persisted theme, live system changes, keyboard focus visibility, storage denied, forced colours, reduced motion, 200% text reflow and self-hosted font requests. Screenshots for both themes/viewports are attached to the Playwright report; CI uploads that report. The optional `JOBFLOW_E2E_PORT` changes only the local test server's port (default stays 3100).

CI must repeat quality/security/browser checks and the real Compose PostgreSQL + MinIO integration job before merge. The local integration run did not prove Docker or MinIO startup. Windows execution, human screen-reader testing, 400% browser zoom and owner visual approval of actual #23 business previews remain separate checks; no claim of completed business functionality or permissions is made here. Await QA/code review and exact-head Claude supervisor **Ready to merge** before merging.
