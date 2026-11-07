#!/usr/bin/env bash
# One-time setup of the self-hosted site (#326, #234): the maintenance page,
# the limited deploy permission, the scheduled jobs timer, and starting the
# database and file storage at boot. Safe to run again.
# Usage, after a deploy that includes this file:
#   sudo bash /home/prod/tax-invoice-run/infra/host/install.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
if [ ! -f "$root/scripts/jobs/cli.ts" ]; then
  echo "This copy doesn't have the scheduled jobs yet. Deploy first." >&2
  exit 1
fi

echo "==> Installing nginx"
if dpkg-query -W -f='${Status}' nginx 2>/dev/null | grep -q "ok installed"; then
  # Already here, so its sites may be in use: leave them all alone. JobFlow's
  # gate is a separate file that listens only on 127.0.0.1:3299.
  echo "nginx was already installed; its existing sites are unchanged."
else
  apt-get install -y nginx
  # Ubuntu's sample site, just installed, listens on every network address.
  rm -f /etc/nginx/sites-enabled/default
fi

echo "==> Installing the maintenance page"
install -d -o root -g root -m 0755 /usr/share/jobflow-maintenance
install -d -o prod -g prod -m 0755 /var/lib/jobflow-maintenance
install -o root -g root -m 0644 "$here/maintenance/index.html" \
  "$here/maintenance/index.json" /usr/share/jobflow-maintenance/
install -o root -g root -m 0644 "$here/nginx-gate.conf" \
  /etc/nginx/conf.d/jobflow-gate.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> Allowing the deploy script to stop and start the app"
visudo -cf "$here/sudoers-jobflow-deploy"
install -o root -g root -m 0440 "$here/sudoers-jobflow-deploy" \
  /etc/sudoers.d/jobflow-deploy

echo "==> Starting the database and file storage at boot"
install -o root -g root -m 0644 "$here/jobflow-services.service" /etc/systemd/system/
install -d -o root -g root -m 0755 /etc/systemd/system/jobflow.service.d
install -o root -g root -m 0644 "$here/jobflow.service.d/services.conf" \
  /etc/systemd/system/jobflow.service.d/services.conf
systemctl daemon-reload
# Already running ones are left alone; this only takes over the next boots.
systemctl enable --now jobflow-services.service

echo "==> Installing the scheduled jobs timer"
install -o root -g root -m 0644 "$here/jobflow-jobs.service" \
  "$here/jobflow-jobs.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jobflow-jobs.timer

echo
echo "==> Checking"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3299/api/health || true)"
echo "Through nginx: $code (expect 200)"
systemctl list-timers jobflow-jobs.timer --no-pager | sed -n 1,2p
systemctl is-enabled jobflow-services.service
echo
echo "Done. One step is left, in the Cloudflare dashboard: under Zero Trust ->"
echo "Networks -> Tunnels, change this site's service from http://localhost:3300"
echo "to http://localhost:3299. Until then, visitors don't get the maintenance page."
