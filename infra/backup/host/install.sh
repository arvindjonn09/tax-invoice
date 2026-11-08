#!/usr/bin/env bash
# One-time setup of nightly backups to a Windows file share (#351). Safe to run
# again: it keeps an existing encryption key. Run after a deploy that has it:
#   sudo bash /home/prod/tax-invoice-run/infra/backup/host/install.sh
# It uses a share that's already mounted, or asks for the share and its
# Windows account and mounts it. Nothing it asks for is kept in the repository.
#
# The read-only backup login is created through the app's DATABASE_URL. If
# that login can't create roles (a least-privilege app login), give an owner
# connection for this one step:
#   sudo BACKUP_ADMIN_DATABASE_URL='postgresql://owner:...@127.0.0.1:5432/db' bash install.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=share.sh
. "$here/share.sh"
app=/home/prod/tax-invoice-run
[ -f "$app/.env" ] || { echo "$app/.env not found" >&2; exit 1; }

echo "==> Installing pg_dump and psql (PostgreSQL 16, as the server) and the file-share client"
apt-get install -y cifs-utils postgresql-client-16

echo "If the share is already mounted on this computer (for example /mnt/jobflow),"
read -rp "type that folder. Leave it empty to set the share up now: " existing
if [ -n "$existing" ]; then
  mountpoint="${existing%/}"
  # A share, not just any mounted folder: a local disk here would keep the
  # "off-site" copies on this computer.
  if ! share_mounted "$mountpoint"; then
    echo "$mountpoint isn't a mounted Windows (SMB) share." >&2
    exit 1
  fi
  if ! runuser -u prod -- test -w "$mountpoint"; then
    echo "The prod user can't write to $mountpoint. Mount it with uid=prod,gid=prod." >&2
    exit 1
  fi
else
  mountpoint=/mnt/jobflow-backup
  read -rp "Windows share, for example //computer-name/jobflow: " share
  read -rp "Windows user name (COMPUTER\\user for a local account): " user
  read -rsp "Windows password (not shown): " password
  echo
  case "$share" in //*/*) ;; *) echo "Write the share as //computer/folder" >&2; exit 1 ;; esac
  domain=""
  case "$user" in *\\*) domain="${user%%\\*}"; user="${user#*\\}" ;; esac

  echo "==> Saving the share's account (root only)"
  install -d -o root -g root -m 0700 /etc/jobflow
  umask 077
  {
    printf 'username=%s\npassword=%s\n' "$user" "$password"
    [ -z "$domain" ] || printf 'domain=%s\n' "$domain"
  } >/etc/jobflow/backup-share.cred
  chmod 0600 /etc/jobflow/backup-share.cred
  unset password

  echo "==> Mounting the share on demand at $mountpoint (SMB 3.1.1, encrypted)"
  install -d -o prod -g prod -m 0700 "$mountpoint"
  line="$share $mountpoint cifs credentials=/etc/jobflow/backup-share.cred,uid=prod,gid=prod,file_mode=0600,dir_mode=0700,vers=3.1.1,seal,_netdev,nofail,x-systemd.automount,x-systemd.idle-timeout=600 0 0"
  grep -v " $mountpoint cifs " /etc/fstab >/etc/fstab.jobflow-new || true
  printf '%s\n' "$line" >>/etc/fstab.jobflow-new
  cp /etc/fstab /etc/fstab.before-jobflow-backup
  mv /etc/fstab.jobflow-new /etc/fstab
  chmod 0644 /etc/fstab
  systemctl daemon-reload
  # Only this share's on-demand mount: restarting all remote mounts would
  # bounce any other network mounts on this computer.
  systemctl start "$(systemd-escape -p --suffix=automount "$mountpoint")"
  if ! share_mounted "$mountpoint"; then
    echo "The share didn't mount. Check the address, user name and password, and that" >&2
    echo "the Windows folder is shared with that account. /etc/fstab was saved first" >&2
    echo "as /etc/fstab.before-jobflow-backup." >&2
    exit 1
  fi
fi
share_dir="$mountpoint/backups"
runuser -u prod -- mkdir -p "$share_dir"

echo "==> A read-only database login for backups"
# Connection strings are split into libpq's PG* variables, so no password
# is ever on a command line (other users can read those in /proc). Read on
# stdin for the same reason. Percent-encoding in the URL is decoded.
pg_env() {
  python3 -I -c '
import shlex, sys, urllib.parse as u
p = u.urlsplit(sys.stdin.read().strip())
if p.scheme not in ("postgres", "postgresql") or not p.hostname:
    sys.exit("not a postgresql:// URL")
for name, value in (
    ("PGHOST", p.hostname),
    ("PGPORT", str(p.port or 5432)),
    ("PGUSER", u.unquote(p.username or "")),
    ("PGPASSWORD", u.unquote(p.password or "")),
    ("PGDATABASE", u.unquote(p.path.lstrip("/"))),
):
    print(f"{name}={shlex.quote(value)}")
'
}
db_url="$(grep '^DATABASE_URL=' "$app/.env" | cut -d= -f2- | tr -d '"')"
app_db="$(printf '%s' "$db_url" | pg_env)"
db_host="$(eval "$app_db"; printf '%s' "$PGHOST")"
db_port="$(eval "$app_db"; printf '%s' "$PGPORT")"
db_name="$(eval "$app_db"; printf '%s' "$PGDATABASE")"
admin_db="$(printf '%s' "${BACKUP_ADMIN_DATABASE_URL:-$db_url}" | pg_env)"
admin_psql() (
  eval "$admin_db"
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  # runuser keeps the environment (no --login), so psql gets the PG* values.
  runuser -u prod -- /usr/bin/psql -X "$@"
)
# PostgreSQL 16: CREATEROLE alone can't grant pg_read_all_data; that needs
# a superuser or ADMIN OPTION on it.
can_grant="$(admin_psql -tAq -c "SELECT rolsuper OR (rolcreaterole AND pg_has_role(current_user, 'pg_read_all_data', 'MEMBER WITH ADMIN OPTION')) FROM pg_roles WHERE rolname = current_user")"
if [ "$can_grant" != t ]; then
  echo "This database login can't create the backup role and grant it pg_read_all_data." >&2
  echo "Run again with BACKUP_ADMIN_DATABASE_URL set to a superuser (owner) connection" >&2
  echo "(see the top of this script)." >&2
  exit 1
fi
role_password="$(openssl rand -hex 24)"
# The password reaches psql through the environment (\getenv), not its
# command line, and goes into SQL quoted by psql (:'...').
JOBFLOW_BACKUP_ROLE_PASSWORD="$role_password" admin_psql -v ON_ERROR_STOP=1 -q <<'SQL'
\getenv role_password JOBFLOW_BACKUP_ROLE_PASSWORD
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jobflow_backup') AS create_role \gset
\if :create_role
  CREATE ROLE jobflow_backup LOGIN;
\endif
ALTER ROLE jobflow_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT PASSWORD :'role_password';
GRANT pg_read_all_data TO jobflow_backup;
SQL

echo "==> Backup settings (root only)"
install -d -o root -g root -m 0700 /etc/jobflow
umask 077
{
  # The app's own host and port, not an assumed 127.0.0.1:5432.
  echo "DATABASE_URL=postgresql://jobflow_backup:$role_password@$db_host:$db_port/$db_name"
  grep -E '^(APP_ENV|S3_[A-Z_]*|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|MINIO_API_PORT)=' "$app/.env" || true
  # For the daily health check's email alert (#355).
  grep -E '^(SMTP_[A-Z_]*|EMAIL_FROM|EMAIL_REPLY_TO|OPERATOR_NOTIFY_EMAIL)=' "$app/.env" || true
  echo "BACKUP_ROOT=/home/prod/jobflow-backups"
  echo "BACKUP_SHARE_MOUNT=$mountpoint"
  echo "BACKUP_SHARE_DIR=$share_dir"
  echo "PATH=/home/prod/.local/bin:/usr/local/bin:/usr/bin:/bin"
} >/etc/jobflow/backup.env
chmod 0600 /etc/jobflow/backup.env
install -d -o prod -g prod -m 0700 /home/prod/jobflow-backups

new_key=no
if [ ! -s /etc/jobflow/backup-key.env ]; then
  echo "BACKUP_ENCRYPTION_KEY=$(openssl rand -base64 32)" >/etc/jobflow/backup-key.env
  new_key=yes
fi
chmod 0600 /etc/jobflow/backup-key.env

echo "==> Installing the nightly backup (02:15 Sydney time), the hourly copy retry"
echo "    and the daily health check that emails you about problems (09:00)"
install -o root -g root -m 0644 "$here/jobflow-backup.service" \
  "$here/jobflow-backup.timer" "$here/jobflow-backup-sync.service" \
  "$here/jobflow-backup-sync.timer" "$here/jobflow-backup-health.service" \
  "$here/jobflow-backup-health.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jobflow-backup.timer jobflow-backup-sync.timer \
  jobflow-backup-health.timer

echo "==> Making the first backup now"
if systemctl start jobflow-backup.service; then
  echo "First backup made, copied to the share and verified:"
  ls -1 "$share_dir" | grep -v '^\.' | tail -3
else
  echo "The first backup failed. See: journalctl -u jobflow-backup.service -n 50" >&2
fi

echo "==> Sending a test alert email to OPERATOR_NOTIFY_EMAIL"
# Exactly as the timer runs it: as prod, with the same EnvironmentFile, so
# the settings are parsed the same way.
if systemd-run --wait --quiet --collect --uid=prod --gid=prod \
  --property=EnvironmentFile=/etc/jobflow/backup.env \
  --property=WorkingDirectory="$app" \
  /bin/sh "$app/infra/backup/host/health.sh" --test; then
  echo "Check that inbox (and its spam folder) for \"JobFlow backup alerts are set up\"."
else
  echo "The test email failed. Check SMTP_* and OPERATOR_NOTIFY_EMAIL in $app/.env," >&2
  echo "then run this script again. Details: journalctl -n 30" >&2
fi

if [ "$new_key" = yes ]; then
  echo
  echo "================================================================"
  echo "SAVE THIS KEY NOW, somewhere other than this computer and the"
  echo "share (a password manager). Without it no backup can be restored."
  echo
  sed 's/^BACKUP_ENCRYPTION_KEY=//' /etc/jobflow/backup-key.env
  echo "================================================================"
fi
