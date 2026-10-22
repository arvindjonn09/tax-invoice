# ADR 0002: Local PostgreSQL, Prisma and isolated test databases

Status: proposed for #9 supervisor review. Date: 22 October 2026.

## Decision

Use PostgreSQL 16.15-bookworm in local Compose, Prisma/client/adapter-pg 7.10.1 and pg 8.16.3.
Prisma 7.10.1 is a stable release supported on Node 24; the registry's `prisma` latest tag currently
points to an 8 prerelease, so it is deliberately not used. Prisma/client/adapter versions are aligned
and pinned in the manifest/lockfile. Prisma/pg are Apache-2.0/MIT; PostgreSQL uses the PostgreSQL
licence. See [Prisma configuration](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference),
[driver adapters](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/introduction),
and [Postgres image source](https://github.com/docker-library/postgres).

The empty schema and no-op `20261022000000_bootstrap` migration establish generated-client and
migration tooling without premature tenancy/financial entities. Prisma creates its internal
`_prisma_migrations` table; no application table exists yet. The real company/user schema belongs
to #12. `createDatabaseClient` is an internal server factory; services must authenticate and apply
company/object policies before business operations. No public health endpoint queries the database.

Each integration run validates the loopback-only base `jobflow_test` URL, creates a fresh database
with a UUID suffix, applies committed migrations, and removes it on success, failure or ordinary
SIGINT/SIGTERM interruption. Concurrent runs do not share state. This requires a **local-only**
CREATEDB role. Production must use separate non-superuser roles, with migration privileges separated
from application privileges. The reset helper permits only exact `jobflow_test`, explicit acknowledgement,
nonproduction mode, no URL options and a distinct development target. It never resets `jobflow`.

MinIO runs as an independent local container, built from official source release
`RELEASE.2025-10-15T17-29-55Z`, commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`.
Anonymous official Quay manifest requests returned 401 and archived official binary requests returned
410 on 22 October 2026. Do not use an unaudited mirror. The Dockerfile pins official Go 1.26.7 and
Debian 12.13 base digests and uses the committed Go module checksums. Upstream source is
[MinIO](https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a), licensed
[AGPL-3.0](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/LICENSE).
The server is unmodified, source remains available at the pinned link, its licence is included in
the container, and no MinIO source is incorporated into the Next.js application. It runs as a
non-root user with a private named volume and loopback ports. This is a development fixture,
not a production storage selection or security certification. M2 private-storage work and M5
operations review must reassess upstream maintenance, dependencies and licence obligations before
network deployment. No bucket, anonymous policy or file-upload API is introduced here.

## Consequences and limits

A clean Compose start builds MinIO from source, so the first run downloads Go modules and takes
longer than a prebuilt image. Local generation uses random credentials in a mode-0600 ignored `.env`;
example files contain placeholders only. Docker's local Postgres superuser is development-only.
Changes to init scripts apply only to fresh database volumes. Keep data with `docker compose down`;
`--volumes` is destructive and reserved for disposable local environments.

Prisma does not support automatic down migrations: develop a new forward migration for schema
changes, and reset only disposable test databases. The no-op baseline has no application changes
to undo. SIGKILL, machine/power loss or database outage can prevent cleanup; inspect and remove only
confirmed abandoned `jobflow_test_<uuid>` databases with local administrative tooling. Never use a
wildcard drop. Normal failures are tested for cleanup.

## Validation

Local PostgreSQL 16.15 was available separately from Compose. Prisma generation/validation,
migrations and rollback/isolation tests pass against it. The guarded reset was blocked
locally by Prisma's AI safety check; it is not claimed as a local pass. This host lacks Docker;
the CI verify job must build/start both services, check health, deploy migrations twice, reset the
base test database, and run integration tests on clean volumes. Application auth, tenant isolation,
financial fixtures and upload behaviour remain separate milestone issues.

Detailed acceptance mapping and actual local evidence: [database setup verification](../testing/database-setup.md).
