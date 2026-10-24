# Backups and restore (#63)

JobFlow keeps financial records. Losing them is not acceptable, and neither is leaking them through a backup.

Each backup holds the whole PostgreSQL database and every stored document. Everything in it is encrypted before it touches the disk.

## What a backup contains

A backup is a directory named by its UTC time, for example `2026-10-25T021500Z/`:

| File | Contents |
|---|---|
| `manifest.json` | Format, time, sizes, counts and the SHA-256 of every encrypted file. It holds no data, no object keys and no secrets. |
| `database.dump.enc` | `pg_dump --format=custom --no-owner --no-privileges`, encrypted while it streams, so plaintext never reaches the disk. |
| `objects.json.enc` | An encrypted index: object key → file, size and SHA-256. |
| `objects/NNNNNN.enc` | One encrypted file per stored document. |

**Encryption:**
- AES-256-GCM, with a 32-byte key from `BACKUP_ENCRYPTION_KEY` (base64).
- Every file gets its own random IV and an authentication tag.
- A changed byte, a truncated file or a wrong key fails the restore. It never restores wrong data.
- Code: `apps/web/src/server/backup/backup.ts`. CLI: `scripts/backup/cli.ts`.

## Commands

```sh
pnpm backup:create <new-dir>          # encrypted backup of DATABASE_URL + document storage
pnpm backup:verify <dir>              # checks every file against the manifest
pnpm backup:restore <dir>             # into RESTORE_DATABASE_URL (must be empty) and RESTORE_S3_BUCKET
pnpm backup:prune <root> --keep-daily 30 --keep-monthly 12
pnpm backup:drill --record docs/ops/restore-drills
```

- **Storage:** the commands use the same storage settings as the app: `S3_*`, or the local MinIO.
- **Restore:**
  - It refuses a database that already has tables.
  - With `APP_ENV=production`, it also needs `RESTORE_CONFIRM=restore-into-empty-database`.
- **Error messages** never print connection strings or keys.

## Schedule (production and staging)

`infra/backup/` holds a systemd unit and timer, plus `run-backup.sh`.

- **Nightly** at 02:15 Australia/Sydney, the job will:
  - back up
  - verify
  - prune to **30 daily + 12 monthly** backups
  - copy the new backup off-site (`BACKUP_OFFSITE_S3_URI`)
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

## Restore drills

- **Command:** `pnpm backup:drill` backs up the configured database and storage, then verifies them. It restores into a fresh disposable database and bucket, compares every table's row count and every document byte for byte, records the timings, and cleans up.
- **Recording:** `--record docs/ops/restore-drills` writes the dated result. Commit it.
- **How often:** every month, and after any change to the schema or storage. Run on staging with production-like (synthetic) volume.
- **Tests:** `tests/integration/backup.test.ts` covers the round trip in CI, along with:
  - no plaintext data or object keys in any file
  - a tampered file or the wrong key refused
  - a non-empty target refused
  - retention pruning

Drills so far: [restore-drills/](restore-drills/).
