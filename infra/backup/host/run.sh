#!/bin/sh
# Nightly backup on the self-hosted site (#351): an encrypted backup made and
# verified locally (infra/backup/run-backup.sh), then every backup the share
# is missing copied there and verified (sync.sh). If the share can't be
# reached the local backup is kept, this run fails visibly, and the hourly
# jobflow-backup-sync.timer copies it once the share is back.
# Settings come from /etc/jobflow/backup.env.
set -eu
: "${BACKUP_ROOT:?}" "${BACKUP_SHARE_DIR:?}"
umask 077

sh infra/backup/run-backup.sh
exec sh infra/backup/host/sync.sh
