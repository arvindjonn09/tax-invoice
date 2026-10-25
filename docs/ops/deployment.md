# Deployment and rollback (#66)

This is the runbook for putting a JobFlow release on a server and taking it back off. The staging environment is the model ([staging.md](staging.md)), and production follows the same steps on its own host, with its own keys, database and bucket.

> **Status:** these commands are the ones the staging configuration runs (`infra/staging/deploy.sh`, `.github/workflows/staging.yml`). They still have to be run against a real staging host. The issue's acceptance item "commands verified against staging" stays open until the owner provisions staging and records the first deploy below.

## What a release is

- A release is a commit on `main` whose CI is green: type-check, lint, unit and integration tests, e2e, security checks, plus the `Staging config` image build and config checks.
- Migrations live in `packages/database/prisma/migrations/` and only ever go forward.
- Every migration also has a test-only rollback in `packages/database/prisma/rollbacks/`. Those prove the migration can be reversed on an empty test database; they are **not** a production command.

## Before you deploy

1. Check CI is green on the exact commit (`main` tip).
2. Read the migrations it adds (`git diff <live> <new> --stat -- packages/database/prisma/migrations`). For a large or locking change, plan a quiet window.
3. Take a fresh backup and verify it:

   ```sh
   sudo systemctl start jobflow-backup.service    # back up, verify, copy off-site, prune
   journalctl -u jobflow-backup.service -n 20      # expect "jobflow backup <stamp> ok"
   ```

   See [backups.md](backups.md). Write down the backup stamp, because it is your way back if a migration has to be undone.

## Deploy

**From CI** (once the owner has turned it on, see [staging.md](staging.md#deploying-from-ci-owner-turns-it-on)):
- A push to `main` runs the `deploy` job after the image and config checks pass.
- It needs approval in the `staging` environment.
- The host's forced command checks out exactly the tip of `main`, builds the images, runs migrations, then replaces the app and nginx.
- The job polls `/api/health/ready` until it answers 200.

**By hand on the host:**

```sh
cd /opt/jobflow
sudo -u deploy SSH_ORIGINAL_COMMAND="deploy $(git rev-parse origin/main)" /usr/local/sbin/jobflow-deploy
```

The script runs these steps in order:
1. `git fetch`, then a refusal unless the commit is the current tip of `origin/main`.
2. `docker compose build migrate web`.
3. `docker compose up -d --wait postgres`.
4. `docker compose run --rm migrate`. This runs `prisma migrate deploy` as the database owner, then re-grants the least-privilege runtime role. **If it fails, the script stops here and the old app keeps running.**
5. `docker compose up -d --no-deps --wait web`, which starts the new app and waits for its health check.
6. `docker compose up -d --no-deps --force-recreate --wait nginx`, which re-renders the proxy config for the new app.

## Check the release

```sh
curl -fsS https://<host>/api/health          # {"status":"ok",...}
curl -fsS https://<host>/api/health/ready    # {"status":"ready",...}
docker compose -f infra/staging/compose.yml ps
docker compose -f infra/staging/compose.yml logs --since 10m web | grep '"level":"error"' || echo "no errors"
```

Then, signed in as an office user on staging:
- Open an issued invoice and use **Get PDF**.
- Open a supplier bill and its document.
- Check **Settings** shows the GST registration.

## Roll back

**The app only (no migration in the release):**
- Revert the commit on `main` and let it deploy, or run the deploy script for the reverted tip.
- The CI key can only deploy the tip of `main`, so a rollback is always a new commit.

**A release that added migrations:**
- **Additive migrations** (new tables or columns, the common case): the previous app version still works against the newer schema, so roll back the app as above and leave the schema.
- **Migrations the old app can't run against:**
  1. Put the app in maintenance by stopping `web`: `docker compose -f infra/staging/compose.yml stop web`.
  2. Restore the backup taken before the deploy into a **new, empty** database and bucket ([backups.md § Restore runbook](backups.md#restore-runbook)).
  3. Point `web.env` at the restored copies.
  4. Deploy the previous commit as above.
  5. Anything entered after the backup has to be re-entered. Record it in an incident note.
- **Never** run a file from `prisma/rollbacks/` against production, and never edit `_prisma_migrations` by hand.

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
