#!/usr/bin/env bash
# One-time setup of nightly backups to a Windows file share (#351). Safe to run
# again: it keeps an existing encryption key. Run after a deploy that has it:
#   sudo bash /home/prod/tax-invoice-run/infra/backup/host/install.sh
# It asks for the share and its Windows account. Nothing it asks for is kept
# in the repository.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app=/home/prod/tax-invoice-run
mountpoint=/mnt/jobflow-backup
[ -f "$app/.env" ] || { echo "$app/.env not found" >&2; exit 1; }

read -rp "Windows share, for example //computer-name/jobflow: " share
read -rp "Windows user name: " user
read -rsp "Windows password (not shown): " password
echo
case "$share" in //*/*) ;; *) echo "Write the share as //computer/folder" >&2; exit 1 ;; esac

echo "==> Installing the file-share client and pg_dump (PostgreSQL 16, as the server)"
apt-get install -y cifs-utils postgresql-client-16

echo "==> Saving the share's account (root only)"
install -d -o root -g root -m 0700 /etc/jobflow
umask 077
printf 'username=%s\npassword=%s\n' "$user" "$password" >/etc/jobflow/backup-share.cred
chmod 0600 /etc/jobflow/backup-share.cred
unset password

echo "==> Mounting the share on demand at $mountpoint"
install -d -o prod -g prod -m 0700 "$mountpoint"
line="$share $mountpoint cifs credentials=/etc/jobflow/backup-share.cred,uid=prod,gid=prod,file_mode=0600,dir_mode=0700,vers=3.0,_netdev,nofail,x-systemd.automount,x-systemd.idle-timeout=600 0 0"
grep -v " $mountpoint cifs " /etc/fstab >/etc/fstab.jobflow-new || true
printf '%s\n' "$line" >>/etc/fstab.jobflow-new
cp /etc/fstab /etc/fstab.before-jobflow-backup
mv /etc/fstab.jobflow-new /etc/fstab
chmod 0644 /etc/fstab
systemctl daemon-reload
systemctl restart remote-fs.target
if ! ls "$mountpoint" >/dev/null || ! mountpoint -q "$mountpoint"; then
  echo "The share didn't mount. Check the address, user name and password, and that" >&2
  echo "the Windows folder is shared with that account. /etc/fstab was saved first" >&2
  echo "as /etc/fstab.before-jobflow-backup." >&2
  exit 1
fi

echo "==> A read-only database login for backups"
db_url="$(grep '^DATABASE_URL=' "$app/.env" | cut -d= -f2- | tr -d '"')"
db_name="${db_url##*/}"
db_name="${db_name%%\?*}"
role_password="$(openssl rand -hex 24)"
runuser -u prod -- /usr/bin/psql "$db_url" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jobflow_backup') THEN
    CREATE ROLE jobflow_backup LOGIN;
  END IF;
END \$\$;
ALTER ROLE jobflow_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$role_password';
GRANT pg_read_all_data TO jobflow_backup;
SQL

echo "==> Backup settings (root only)"
{
  echo "DATABASE_URL=postgresql://jobflow_backup:$role_password@127.0.0.1:5432/$db_name"
  grep -E '^(APP_ENV|S3_[A-Z_]*|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|MINIO_API_PORT)=' "$app/.env" || true
  echo "BACKUP_ROOT=/home/prod/jobflow-backups"
  echo "BACKUP_SHARE_DIR=$mountpoint"
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

echo "==> Installing the nightly timer (02:15 Sydney time)"
install -o root -g root -m 0644 "$here/jobflow-backup.service" \
  "$here/jobflow-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jobflow-backup.timer

echo "==> Making the first backup now"
if systemctl start jobflow-backup.service; then
  echo "First backup made, copied to the share and verified:"
  ls -1 "$mountpoint" | grep -v '^\.' | tail -3
else
  echo "The first backup failed. See: journalctl -u jobflow-backup.service -n 50" >&2
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
