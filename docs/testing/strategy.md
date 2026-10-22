# Test strategy

How JobFlow is tested, and which command to run for what. Every PR must keep all of these green in CI.

## Layers

| Layer | Command | Location | Runs against |
|---|---|---|---|
| Unit | `pnpm test` (Vitest project `unit`) | `tests/unit/`, `apps/web/tests/`, `packages/*/test/` | Pure code; no database or network |
| Domain coverage | `pnpm test:coverage` | `packages/domain/src/` | Unit tests; **100%** lines/branches/functions/statements required |
| Integration | `pnpm test:integration` (Vitest project `integration`) | `tests/integration/` | A fresh, migrated `jobflow_test_<uuid>` database per run, dropped afterwards |
| End-to-end | `pnpm test:e2e` | `tests/e2e/` | The Next.js app in Chromium, including axe accessibility checks |
| Domain research contract | CI `research-contract` | `tests/domain-rules/` | Arithmetic of the ATO-verified fixtures (moves into the Vitest domain suite with #17) |

Integration tests must be started through `pnpm test:integration`; `connectIsolatedDatabase()` refuses any other database.

## Isolation

- **Per run:** the runner creates, migrates and drops a unique database (`scripts/database/test-runner.mjs`).
- **Per test:** wrap writes in `withRollback(client, async (tx) => …)` from `tests/support/database.ts`. The transaction is always rolled back, but deferred constraints are checked first (`SET CONSTRAINTS ALL IMMEDIATE`), so integrity violations still fail the test.
- **Between files:** files run in parallel against the same run database. Give each file its own factory scope (`createFactories("invoices")`) so unique values never collide.
- Tests that must observe a real `COMMIT` (for example deferred constraints at commit time or concurrency races) may commit; they must create their own records and must not depend on other files' data.

## Synthetic data

Use `tests/support/factories.ts` and `tests/support/synthetic.ts`:

- `createFactories(scope)` returns `user`, `companyWithOwner` (company, owner and bootstrap membership in one transaction; demo by default) and `member`.
- Values are deterministic: `<scope>-user-<n>@example.test`, `Sample Company <scope> <n>`, `Sample Person <scope> <n>`. The `.test` domain is reserved, so mail can never be delivered.
- Never use real names, ABNs, addresses, bank details or customer data in tests, seeds or screenshots.

## Determinism

- Vitest runs with `TZ=UTC` and a fixed file order (`sequence.shuffle: false`).
- No real clock: use `vi.useFakeTimers()` with `vi.setSystemTime(REFERENCE_INSTANT)` when code needs "now".
- No real network in unit or integration tests. Database and object storage are local services started by Compose or the runner.
- No unseeded randomness in assertions. Database-generated UUIDs are fine as identifiers; assert on relationships, not on their values.

## Money and GST tests

All amounts are integer cents. GST and job-profit behaviour is tested together in the domain suite (#17), using the fixtures in [GST.md](../GST.md#combined-gst-and-profit-acceptance-fixture) and [domain-gst-profit.md](../research/domain-gst-profit.md). Any change to GST or profit code must keep both the registered and not-registered fixtures passing.
