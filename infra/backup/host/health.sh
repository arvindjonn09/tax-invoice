#!/bin/sh
# Daily backup health check (#355): emails the operator when the nightly
# backup is failing or the share is more than 2 days behind. Run by
# jobflow-backup-health.timer; pass --test to always send.
# Settings come from /etc/jobflow/backup.env.
set -eu
: "${BACKUP_ROOT:?}" "${BACKUP_SHARE_DIR:?}"
mount="${BACKUP_SHARE_MOUNT:-$BACKUP_SHARE_DIR}"

# After downtime, Persistent timers start this and the nightly catch-up
# together: wait for a running backup so it isn't reported as missing.
waited=0
while systemctl is-active --quiet jobflow-backup.service && [ "$waited" -lt 1800 ]; do
  sleep 30
  waited=$((waited + 30))
done

# The last nightly run's exit status. 2 only means the share was unreachable
# (the local backup was kept, and the hourly retry copies it); anything else
# non-zero means making or verifying the backup failed.
nightly=$(systemctl show --property=ExecMainStatus --value jobflow-backup.service 2>/dev/null || echo 0)
failed=""
case "${nightly:-0}" in
  0 | 2) ;;
  *) failed="--nightly-failed=$nightly" ;;
esac

. infra/backup/host/share.sh
share=unreachable
if share_mounted "$mount"; then
  share="$BACKUP_SHARE_DIR"
fi
# shellcheck disable=SC2086 # $failed is one flag or nothing
exec pnpm --silent backup:health --local "$BACKUP_ROOT" --share "$share" $failed "$@"
