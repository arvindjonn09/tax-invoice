# Testing strategy (#11)

Run with the repository's Node/pnpm versions and frozen lockfile. Test data is
synthetic. Real external SMTP, identity providers, Microsoft, storage cloud, payments
and production environments are never contacted by unit tests. Database integration
uses an actual loopback PostgreSQL server; browser tests exercise a newly started
local application. These deliberate local I/O checks do not mock the database/browser.

## Commands and boundaries

| Command | What it proves |
| --- | --- |
| `pnpm test` | Vitest `unit` project: pure behavior, configuration/safety checks, deterministic factories |
| `pnpm test:integration` | Vitest `integration` project in a newly provisioned migrated PostgreSQL database |
| `pnpm test:coverage` | Unit tests plus text/JSON/LCOV/HTML coverage scoped to `packages/domain/src/**/*.ts` |
| `pnpm test:e2e` | Playwright Chromium scaffold/health/responsive smoke tests against a fresh local server |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` | Compiler, style and production compilation gates |

Before integration tests, follow [database setup](database-setup.md), generate the
Prisma client (`pnpm db:generate`), and start the local Postgres service. CI starts
real PostgreSQL and MinIO, waits for health, migrates twice and runs the guarded
reset before running all three test layers. No successful skip replaces DB tests.
Unit tests do not require a live database or generated Prisma client.

`vitest.config.ts` defines explicit named projects so unit commands never accidentally
start integration tests. Integration tests refuse direct unguarded invocation: the
runner provisions a UUID-named database from the known local test base and drops it
on ordinary completion/failure/signals. SIGKILL/host loss can leave a disposable
DB; never delete databases without confirming their origin and ownership.

## Per-test database isolation

Row-level tests must wrap work in `withTestDatabase` from `tests/helpers/database.ts`,
or a Vitest fixture that calls it. Each callback gets a Prisma transaction client;
it rolls back **after success as well as failure**, disconnects and preserves the
original exception. The helper checks loopback, exact UUID database name, matching
test URL and the runner marker, and rejects production. Do not write through a
separate global client from inside a rollback-isolated test.

```ts
await withTestDatabase(async database => {
  const factory = syntheticFactory(1201);
  const user = await database.user.create({ data: factory.user() });
  // Assert behavior using this transaction's database client only.
});
```

Each test gets its own factory. Numeric namespaces must be distinct across parallel
writers; sequence IDs, `example.test` identities and company demo flags are stable
and independent of test order. Factory functions have no clock, unseeded randomness,
global counters or external services. Database timestamps are actual server instants;
assert types/order/contracts rather than current wall-clock equality.

PostgreSQL aborts a transaction after a rejected statement. Use
`expectRejectedWrite(database, () => operation)` to assert a failure behind a
savepoint, then restore the transaction for later assertions. Do not catch a DB error
and continue issuing statements in an aborted transaction. Audit INSERTs roll back
normally; immutable audit records are never truncated/deleted for cleanup.

Tests requiring commits, concurrent independent connections, DDL roundtrips or
migration changes instead provision a **separate disposable database per test** via
`withIsolatedDatabase`. Existing concurrency, isolation and migration tests show this
pattern. They cannot alter the shared run database's schema underneath other tests.
Database names may be random to prevent operational collisions; expected business
data and assertions remain deterministic. No shared development database is reset.

Regression cases explicitly prove success/failure/SQL-error rollback, preserved
errors, parallel isolated callbacks, deferred company bootstrap, all five roles,
cross-company creator rejection, audit immutability and a single committed winner
for concurrent duplicate idempotency keys.

## Determinism, coverage and browser evidence

Freeze the clock with Vitest fake timers and an explicit UTC instant for clock-based
business behavior. Mock external HTTP at the boundary; fail unexpected requests and
assert both success/failure paths. Avoid sleeps, random expected values, shared mutable
factory state and ordering dependencies. Concurrent DB tests must use independent
namespaces and explicit concurrency assertions. Authorization tests must cover every
role, missing/inactive membership, wrong company and wrong object when #14 lands.

Domain coverage includes new unimported source files automatically; reports are saved
under ignored `coverage/domain/` and uploaded by CI. **The current domain package is
an empty reserved module: 0 executable statements/functions.** A displayed 100% of
0/0 is not financial coverage or a completed calculation core. #17 must add behavior
and the combined GST/profit fixtures before making a coverage claim. No arbitrary
threshold is offered as a substitute for acceptance tests.

Playwright starts its own server and refuses to reuse another process on the port.
It uses en-AU/Australia-Sydney, retains failing traces/screenshots and HTML reports,
and checks health, unknown paths and five viewport widths in both themes. These are
scaffold smoke checks; they do not verify login, permissions, invoices or GST yet.
Add feature-specific behavior, keyboard/accessibility, empty/error/loading and tenant
cases with each feature. Screenshots/traces must contain synthetic data only.

## Verification recorded for #11

The local host has native PostgreSQL 16.15 and Chromium, **no Docker**. Local type,
lint, unit/integration/browser/build and audit evidence is recorded in the issue PR;
Compose startup, health and migration-rerun evidence must come from the exact-head CI.
CI must pass and the exact-head Claude supervisor review must say Ready to merge.
Neither this document nor automated self-tests replace that independent review.
