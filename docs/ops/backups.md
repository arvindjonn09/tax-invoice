# Backups and restore (#63)

JobFlow keeps financial records. Losing them is not acceptable, and neither is leaking them through a backup.

Each backup holds the whole PostgreSQL database and every stored document. Everything in it is encrypted before it touches the disk.

## What a backup contains

A backup is a directory named by its UTC time, for example `2026-10-25T021500Z/`:

| File | Contents |
|---|---|
| `manifest.json` | Format, backup id, time, sizes, counts and the SHA-256 of every encrypted file. It holds no data, no object keys and no secrets. |
| `database.dump.enc` | `pg_dump --format=custom --no-owner --no-privileges`, encrypted while it streams, so plaintext never reaches the disk while backing up. |
| `objects.json.enc` | An encrypted index: the dump's plaintext SHA-256, and for each document its key, file, size and SHA-256. |
| `objects/NNNNNN.enc` | One encrypted file per stored document. |

**Encryption:**
- AES-256-GCM, with a 32-byte key from `BACKUP_ENCRYPTION_KEY` (base64).
- Every file gets its own random IV and an authentication tag.
- Every file is bound, as additional authenticated data, to its backup id and file name. A file swapped in from another backup or position fails, even if someone rewrites the manifest.
- A changed byte, a truncated or substituted file, or a wrong key fails the restore. It never restores wrong data.
- **Restore order:** before `pg_restore` reads anything, the dump is decrypted to a private temporary file (0600, in a 0700 directory) and checked against the hash sealed in the index. Every document is authenticated before the first one is written.
- **Passwords:** they never appear on the command line. `pg_dump` and `pg_restore` get the password as `PGPASSWORD`, in a minimal environment that holds neither the encryption key nor the storage secrets.
- **What isn't hidden:** the plaintext manifest and the encrypted file sizes reveal how many documents there are, their approximate sizes, the total database size and `APP_ENV`. Nothing else is visible.
- Code: `apps/web/src/server/backup/backup.ts`. CLI: `scripts/backup/cli.ts`.

## Commands

```sh
pnpm backup:create <new-dir>          # encrypted backup of DATABASE_URL + document storage
pnpm backup:verify <dir>              # checks every file against the manifest, then decrypts and authenticates each one (needs the key)
pnpm backup:restore <dir>             # into RESTORE_DATABASE_URL (must be empty) and RESTORE_S3_BUCKET
pnpm backup:prune <root> --keep-daily 30 --keep-monthly 12
pnpm backup:drill --record docs/ops/restore-drills
```

- **Storage:** the commands use the same storage settings as the app: `S3_*`, or the local MinIO.
- **Restore:**
  - It refuses a database that already has tables.
  - With `APP_ENV=production`, it also needs `RESTORE_CONFIRM=restore-into-empty-database`.
- **Error messages** never print connection strings or keys.

## Schedule

There are two ways to run the nightly job. Both run `infra/backup/run-backup.sh`.
- **Staging (Compose)** runs it in a container. See [Staging (Compose)](#staging-compose) below.
- **A host with Node, `pg_dump` 16 and the pnpm CLI** uses the unit and timer in `infra/backup/`. It runs from `/srv/jobflow`, so set `WorkingDirectory` and `ExecStart` to your checkout.

- **Nightly** at 02:15 Australia/Sydney, the job will:
  - back up
  - verify
  - copy the new backup off-site (`BACKUP_OFFSITE_S3_URI`)
  - prune to **30 daily + 12 monthly** complete backups. A directory without a `manifest.json`, left by a failed run, is never counted or deleted: it's reported for review instead.
- **Runs as** user `jobflow-backup` with a hardened unit: `ProtectSystem=strict`, and it may write only to `/var/backups/jobflow`.
- **Database role:** `DATABASE_URL` in `/etc/jobflow/backup.env` should be a **read-only** role with `pg_read_all_data`, not the app or owner role.
- **Off-site copies:** the off-site bucket belongs to a different account from the live documents. It has versioning, plus object lock or retention, so a compromised server can't delete its own backups.

Install:

```sh
sudo install -m 0644 infra/backup/jobflow-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jobflow-backup.timer
systemctl list-timers jobflow-backup.timer
```

**Targets:**
- **RPO:** 24 hours, from the nightly backups. Shorten it by running the timer more often, or by adding PostgreSQL WAL archiving later.
- **RTO:** under 1 hour for pilot-sized data. Re-measure with every drill.

## Staging (Compose)

Staging's database sits on an internal network with no published port. So the backup runs as the `backup` Compose service, on the same network (#173).
- **Image:** the `backup` target of `apps/web/Dockerfile`, which has `pg_dump` 16 and the AWS CLI. `deploy.sh` rebuilds it with every release, so backups always run the released code.
- **Runs as:** non-root, with a read-only filesystem and all capabilities dropped.
- **Writes to:** `/var/backups/jobflow` on the host.

**Set it up once:**
1. In `migrate.env`, set `BACKUP_DATABASE_PASSWORD` to 24+ random hex characters. The next deploy's `migrate` job then creates the read-only `jobflow_backup` role (`pg_read_all_data`).
2. Copy `infra/staging/env/backup.env.example` to `backup.env` and set `DATABASE_URL` to that role, using the same password. Give it a storage key that can only **read** the documents bucket. Optionally set the off-site bucket and its key too.
3. Put the key in `/etc/jobflow/backup-key.env` as `BACKUP_ENCRYPTION_KEY=…`. Make the file readable only by `deploy` (`chown root:deploy`, `chmod 0440`).
4. Create the backup directory for the container's user (uid 1000): `sudo install -d -o 1000 -g 1000 -m 0700 /var/backups/jobflow`.
5. Install the timer:

   ```sh
   sudo install -m 0644 infra/staging/systemd/jobflow-staging-backup.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now jobflow-staging-backup.timer
   sudo systemctl start jobflow-staging-backup.service && journalctl -u jobflow-staging-backup.service -n 20
   ```

**Restore on staging.** Create the empty database inside the stack, then restore as the **owner** role:

```sh
cd /opt/jobflow
C="docker compose -f infra/staging/compose.yml --env-file infra/staging/env/compose.env"
$C exec postgres sh -c 'createdb -U "$POSTGRES_USER" jobflow_restored'
$C --profile backup run --rm \
  -e RESTORE_DATABASE_URL="postgresql://jobflow_owner:<owner password>@postgres:5432/jobflow_restored" \
  -e RESTORE_S3_BUCKET=jobflow-staging-documents-restored \
  backup pnpm --silent backup:restore /backups/<stamp>
```

For the restore, use a storage key that can write the restore bucket, passed with `-e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=…`. Never use the nightly read-only key for this.

## The encryption key

- **Generate it once:** `node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`.
- **Where it lives on the server:** only in `/etc/jobflow/backup-key.env` (root-owned, mode 0400).
- **Where the second copy lives:** offline, in the owner's password manager, and on paper in a safe place.
- **Never** next to the backups, in the repo, or in CI logs.
- **Separate keys:** staging and production use different keys.
- **Rotating:** start using a new key for new backups. Keep the old key for as long as backups made with it are retained (12 months).
- **If the key is lost, the backups can't be read.** Check the offline copy at every drill.

## Restore runbook

1. Pick the backup: `ls /var/backups/jobflow`, or the off-site copy. Then run `pnpm backup:verify <dir>`.
2. Create an **empty** database (`createdb jobflow_restored`) and an empty bucket. Never restore over the live ones.
3. Run:

   ```sh
   RESTORE_DATABASE_URL=postgresql://…/jobflow_restored RESTORE_S3_BUCKET=jobflow-documents-restored \
   BACKUP_ENCRYPTION_KEY=… [RESTORE_CONFIRM=restore-into-empty-database] pnpm backup:restore <dir>
   ```

4. Check it:
   - Run `pnpm db:migrate`. It must report nothing to apply: the dump includes `_prisma_migrations`.
   - Sign in on a staging copy, and spot-check an issued invoice, its PDF and a bill's document.
5. Switch over: point the app's `DATABASE_URL` and `S3_BUCKET` at the restored copies, and restart.
6. Record what happened in an incident note: the time, the backup used, and anything lost since it was taken.

If a restore fails part-way, the target may be partly restored. This can happen when `pg_restore` errors, or when a document write fails after the database was restored. Drop that database (`dropdb jobflow_restored`), empty the restore bucket, and start again from step 2. The live database and bucket are never touched.

## Restore drills

- **Command:** `pnpm backup:drill` backs up the configured database and storage, then verifies and authenticates them with the key. It restores into a fresh disposable database and bucket, compares every table's row count and every document byte for byte, records the timings, and cleans up.
- **Recording:** `--record docs/ops/restore-drills` writes the dated result. Commit it.
- **Permissions:** the drill creates and drops a scratch database, so it needs a role with `CREATEDB`. Run it as an operator, not with the nightly read-only backup role.
- **Scratch bucket:** the drill restores documents into a scratch bucket named `<bucket>-drill-<time>`. It deletes the documents afterwards, but the empty bucket stays. In production, create that bucket in advance with the same encryption and access policy as the live bucket, or run the drill on staging.
- **How often:** every month, and after any change to the schema or storage. Run on staging with production-like (synthetic) volume.
- **Tests:** `tests/integration/backup.test.ts` covers the round trip in CI, along with:
  - no plaintext data or object keys in any file
  - a tampered file or the wrong key refused
  - a non-empty target refused
  - retention pruning

Drills so far: [restore-drills/](restore-drills/).
