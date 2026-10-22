# Database setup verification (#9)

Baseline: PostgreSQL 16.15, Node 24.21.0, pnpm 9.15.4; Linux local run on 23 October
2026 (Australia/Sydney). No Docker engine is installed on this machine.

| Acceptance criterion | Verification | Local result / CI gate |
| --- | --- | --- |
| Clean documented Compose + migration | Pinned PostgreSQL, source-pinned MinIO; `docker compose up --build -d --wait`; verify both service endpoints; deploy migrations twice | Native PostgreSQL migration/idempotence passed; actual Compose start and MinIO health must pass CI |
| Isolated integration database | Fresh UUID database per invocation; migrated Prisma client queries current database; transaction rollback; parallel success/failure cleanup | 4 integration tests passed; no UUID test databases remained |
| No committed secrets | Placeholder-only `.env.example`; private `.env` ignored; generated Prisma/build outputs ignored; Gitleaks on committed content | Existing local `.env` is mode 0600 and unchanged after refused regeneration; Git-only secret scan is required |
| Tests in CI and review | CI verify starts real services before integration; QA/code review and exact-head Claude supervisor review | Local checks below passed; CI and independent supervisor review remain merge gates |

## Commands and results

- `pnpm install --frozen-lockfile`: success, lockfile current.
- `pnpm db:generate`, `pnpm db:validate`: success, Prisma 7.10.1.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: exit 0. Verified install → type-check after removing only the ignored generated Prisma client; root type-check regenerated it automatically.
- `pnpm test`: 5 files, 29 tests passed, including unsafe targets, production
  guards, reset acknowledgement and a runner path containing spaces and `#`. Quoted/whitespace credentials and malformed configuration cannot leak connection URLs in diagnostics.
- Migrations applied twice against isolated local PG16: the second execution
  reports `No pending migrations to apply.`
- `pnpm test:integration` with private local connection variables: 3 files,
  4 tests passed. Tests do not skip when database setup is unavailable.
- `pnpm build`: success; `pnpm test:e2e`: 12 passed.
- `pnpm audit:prod`: no known vulnerabilities. Full audit retains only the
  pre-existing owner-approved development exception; no new exceptions added.
- Entry-point regression: new test failed against the original code and passed
  after using `pathToFileURL`, preventing silent non-execution from escaped paths.
- The existing private `.env` was preserved. A scan of the entire work directory
  finds private local credentials and Next.js generated keys; these are ignored
  and must not be included in the Git-content scan or committed.

## Reset and failure boundaries

`RESET_TEST_DATABASE=yes pnpm db:test:reset` is destructive, limited by the helper
to local `jobflow_test` and forbidden in production or for the development database.
The attempted local reset was rejected by Prisma's AI safety check; no reset ran
and no consent bypass was supplied. CI uses new disposable Compose volumes and
exercises the reset command there. Do not claim the reset was proven locally.

Normal integration success/failure removes disposable databases; SIGKILL, host
failure, or an unavailable database may prevent cleanup. Inspect exact names and
never use a wildcard drop. Database tests do not implement application tenancy,
authorisation, financial calculations, demo records, or file uploads; those remain
separate dependent issues.
