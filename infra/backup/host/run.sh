#!/bin/sh
# Nightly backup on the self-hosted site (#351): an encrypted backup made and
# verified locally (infra/backup/run-backup.sh), then copied to the Windows
# share, verified there, and pruned. Settings come from /etc/jobflow/backup.env.
set -eu
: "${BACKUP_ROOT:?}" "${BACKUP_SHARE_DIR:?}"
umask 077

sh infra/backup/run-backup.sh

# The newest complete backup (one with a manifest).
latest=""
for dir in "$BACKUP_ROOT"/*/; do
  [ -f "$dir/manifest.json" ] && latest="${dir%/}"
done
[ -n "$latest" ] || { echo "No complete local backup to copy" >&2; exit 1; }
name="$(basename "$latest")"

# Touching the folder mounts the share on demand.
ls "$BACKUP_SHARE_DIR" >/dev/null 2>&1 || true
if ! mountpoint -q "$BACKUP_SHARE_DIR"; then
  echo "The share isn't reachable; the local backup $name is kept. Copy failed." >&2
  exit 2
fi
# Copied under .incoming first, so a half-copied backup is never mistaken for
# a complete one, then moved into place.
mkdir -p "$BACKUP_SHARE_DIR/.incoming"
rm -rf "$BACKUP_SHARE_DIR/.incoming/$name"
cp -R "$latest" "$BACKUP_SHARE_DIR/.incoming/$name"
rm -rf "$BACKUP_SHARE_DIR/$name"
mv "$BACKUP_SHARE_DIR/.incoming/$name" "$BACKUP_SHARE_DIR/$name"
pnpm --silent backup:verify "$BACKUP_SHARE_DIR/$name"
pnpm --silent backup:prune "$BACKUP_SHARE_DIR" --keep-daily 30 --keep-monthly 12
echo "jobflow backup $name copied to the share and verified"
