#!/bin/sh
# Nightly encrypted backup (#63): back up, verify, keep 30 daily + 12 monthly,
# then optionally copy off-site. Runs from the app checkout with the
# production environment loaded by systemd (EnvironmentFile); the encryption
# key comes from a separate file that is never stored with the backups.
set -eu

ROOT="${BACKUP_ROOT:-/var/backups/jobflow}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
TARGET="$ROOT/$STAMP"

umask 077
mkdir -p "$ROOT"
pnpm --silent backup:create "$TARGET"
pnpm --silent backup:verify "$TARGET"
pnpm --silent backup:prune "$ROOT" --keep-daily 30 --keep-monthly 12

# Off-site copy (a different account/bucket from the live documents).
if [ -n "${BACKUP_OFFSITE_S3_URI:-}" ]; then
  aws s3 sync --only-show-errors "$TARGET" "$BACKUP_OFFSITE_S3_URI/$STAMP"
fi
echo "jobflow backup $STAMP ok"
