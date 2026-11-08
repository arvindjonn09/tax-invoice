#!/bin/sh
# Copies every complete local backup the share doesn't have yet (#351),
# verifies each copy there, then prunes the share. Run after each nightly
# backup and hourly by jobflow-backup-sync.timer, so backups made while the
# Windows computer was off or asleep reach the share soon after it's back.
# Settings come from /etc/jobflow/backup.env.
set -eu
: "${BACKUP_ROOT:?}" "${BACKUP_SHARE_DIR:?}"
mount="${BACKUP_SHARE_MOUNT:-$BACKUP_SHARE_DIR}"
umask 077

# One copy at a time (the nightly run and the hourly retry can overlap).
mkdir -p "$BACKUP_ROOT"
exec 9>"$BACKUP_ROOT/.sync.lock"
flock -w 1800 9

# Touching the folder mounts the share on demand. Bounded, because a CIFS
# mount attempt to a sleeping computer can hang.
timeout 60 ls "$mount" >/dev/null 2>&1 || true
if ! mountpoint -q "$mount"; then
  echo "The share isn't reachable; local backups are kept and will be copied when it's back." >&2
  exit 2
fi
mkdir -p "$BACKUP_SHARE_DIR/.incoming"

copied=0
for dir in "$BACKUP_ROOT"/*/; do
  [ -f "$dir/manifest.json" ] || continue
  name="$(basename "$dir")"
  [ -f "$BACKUP_SHARE_DIR/$name/manifest.json" ] && continue
  # Copied under .incoming first, so a half-copied backup is never mistaken
  # for a complete one, then moved into place.
  rm -rf "$BACKUP_SHARE_DIR/.incoming/$name"
  cp -R "${dir%/}" "$BACKUP_SHARE_DIR/.incoming/$name"
  pnpm --silent backup:verify "$BACKUP_SHARE_DIR/.incoming/$name"
  rm -rf "$BACKUP_SHARE_DIR/$name"
  mv "$BACKUP_SHARE_DIR/.incoming/$name" "$BACKUP_SHARE_DIR/$name"
  echo "jobflow backup $name copied to the share and verified"
  copied=$((copied + 1))
done

pnpm --silent backup:prune "$BACKUP_SHARE_DIR" --keep-daily 30 --keep-monthly 12
echo "jobflow share sync done: $copied copied"
