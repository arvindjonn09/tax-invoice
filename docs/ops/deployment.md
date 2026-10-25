# Deployment and rollback (#66)

This is the runbook for putting a JobFlow release on staging and taking it back off ([staging.md](staging.md)). Production will follow it on its own host, with its own keys, database and bucket, after the production follow-ups in [staging.md](staging.md#known-follow-ups-before-production) and #168 are done.

> **Status:**
> - The deploy steps match the staging configuration (`infra/staging/deploy.sh`, `.github/workflows/staging.yml`). They haven't run on a real host yet. #66 stays open until the owner provisions staging and records the first deploy below.
> - The pre-deploy backup is blocked on #173.

## What a release is

- A release is a commit on `main`. Before it goes anywhere, **all** of `main`'s CI must be green on that exact commit: type-check, lint, unit and integration tests, e2e, and security checks.
- The CI `deploy` job itself only waits for the image and config checks in `staging.yml`. **The person approving the `staging` environment must check the main CI first.**
- Migrations live in `packages/database/prisma/migrations/` and only ever go forward.
- Each migration has a rollback file in `packages/database/prisma/rollbacks/`. It's a **test-only** proof on an empty database: **never** run one against staging or production, and never edit `_prisma_migrations` by hand.

## Before you deploy

1. Check that main's CI is green on the exact commit.
2. Read the migrations it adds: `git diff <live> <new> --stat -- packages/database/prisma/migrations`. Decide whether each is **backward-compatible** (see below), and plan a quiet window for anything large or locking.
3. Take a backup and verify it, then write down the stamp:

   ```sh
   sudo systemctl start jobflow-backup.service
   journalctl -u jobflow-backup.service -n 20      # expect "jobflow backup <stamp> ok"
   ```

   > **On staging, this step doesn't work yet.** The backup unit can't reach the Compose stack's database: #173. Until that's fixed, don't deploy a release with a migration that isn't backward-compatible.

**Backward-compatible** means the previous app version still works against the new schema. These are safe:
- a new table
- a new column that's nullable or has a default
- a new index

These are **not** safe:
- a new `NOT NULL` column without a default
- a new constraint or trigger that the old code's writes would break
- a rename or a drop

## Deploy

**From CI**, once the owner has turned it on ([staging.md](staging.md#deploying-from-ci-owner-turns-it-on)):
- A push to `main` runs the `deploy` job after the image and config checks.
- It waits for approval in the `staging` environment.
- The host's forced command deploys exactly the tip of `main`, then polls `/api/health/ready`.

**By hand on the host** (fetch first, so the commit is the real tip):

```sh
sudo -u deploy git -C /opt/jobflow fetch origin main
sudo -u deploy SSH_ORIGINAL_COMMAND="deploy $(sudo -u deploy git -C /opt/jobflow rev-parse origin/main)" \
  /usr/local/sbin/jobflow-deploy
```

The script (`infra/staging/deploy.sh`) does the following, in order:
1. Refuses any commit that isn't the tip of `origin/main`. An older `main` commit counts as "superseded": the script does nothing and exits 0.
2. Checks out the commit and runs `docker compose build migrate web`.
3. Runs `docker compose up -d --wait postgres`.
4. Runs `docker compose run --rm migrate`. That's `prisma migrate deploy` as the owner, then the runtime-role grants. **If it fails, the script stops and the old app is still running.**
5. Runs `docker compose up -d --no-deps --wait web`. This replaces the app. If the new container fails its health check, the old one is already gone, so that's an outage: roll back straight away (below).
6. Runs `docker compose up -d --no-deps --force-recreate --wait nginx`.

When `infra/staging/deploy.sh` changes, re-install the gate:

```sh
sudo install -o root -g root -m 0755 infra/staging/deploy.sh /usr/local/sbin/jobflow-deploy
```

## Check the release

```sh
curl -fsS https://<host>/api/health          # liveness
curl -fsS https://<host>/api/health/ready    # database + storage
docker compose -f /opt/jobflow/infra/staging/compose.yml ps
docker compose -f /opt/jobflow/infra/staging/compose.yml logs --since 10m web | grep '"level":"error"' || echo "no errors"
```

Readiness only proves the database answers a query. So also sign in as an office user and check:
- an invoice list and an issued invoice's **Get PDF**
- a supplier bill and its document
- **Settings**, which should show the GST registration

## Roll back

A rollback is always a new commit on `main`, because the deploy gate only accepts the tip.

**The release was backward-compatible (most releases):**
1. Revert the **application code only**. Keep the migration files: deleting an applied migration breaks the next deploy. For a merged PR, use `git revert -m 1 <merge>`, then restore the migration directory from the reverted commit. Push to `main`.
2. Let the deploy job run, or deploy by hand as above.
3. Run the checks above.

**The release wasn't backward-compatible:** don't improvise. Stop and restore, in this order:
1. Stop the app: `docker compose -f /opt/jobflow/infra/staging/compose.yml stop web`.
2. Push a revert commit to `main` that also removes the bad migration. It can't be re-landed under the same name later.
3. Restore the pre-deploy backup into a **new, empty** database and bucket ([backups.md § Restore runbook](backups.md#restore-runbook)). **Skip that runbook's `pnpm db:migrate` check.** The host checkout is still on the bad commit, so running it would re-apply the bad migration.
4. Point **both** `infra/staging/env/migrate.env` (`DATABASE_URL`) and `web.env` at the restored database. Point `web.env` at the restored bucket, and give its key access to it.
5. Deploy the revert tip by hand. The `migrate` job re-applies the runtime-role grants on the restored database. The restore itself carries no grants (`--no-privileges`), so `web` can't read any data until this runs.
6. Check that `/api/health/ready` passes **and** that a real page loads (readiness alone passes without grants).
7. Anything recorded after the backup is still in the old database. **Export it from there, don't re-enter it.** Re-entering issued invoices would give them new numbers. Record what happened in an incident note.

If a migration fails part-way, Prisma marks it failed (error P3009). Leave it for the owner and the database engineer to fix: never edit `_prisma_migrations`.

## Record each deploy

Add a line to the release log in [CHANGELOG.md](../../CHANGELOG.md) under the version you deployed, with:
- the date (Sydney time)
- the environment
- the commit
- the backup stamp taken beforehand
- the checks above that passed

## Related runbooks

- [staging.md](staging.md): the host, TLS, secrets and CI deploy setup.
- [backups.md](backups.md): nightly encrypted backups, restore and drills.
- [documents.md](documents.md): the daily cleanup of unattached uploads.
