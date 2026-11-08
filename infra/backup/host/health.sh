#!/bin/sh
# Daily backup health check (#355): emails the operator when the nightly
# backup is failing or the share is more than 2 days behind. Run by
# jobflow-backup-health.timer; pass --test to always send.
# Settings come from /etc/jobflow/backup.env.
set -eu
: "${BACKUP_ROOT:?}" "${BACKUP_SHARE_DIR:?}"
mount="${BACKUP_SHARE_MOUNT:-$BACKUP_SHARE_DIR}"

. infra/backup/host/share.sh
share=unreachable
if share_mounted "$mount"; then
  share="$BACKUP_SHARE_DIR"
fi
exec pnpm --silent backup:health --local "$BACKUP_ROOT" --share "$share" "$@"
