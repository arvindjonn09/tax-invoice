#!/usr/bin/env bash
# Deploy merged main to the self-hosted site (#326), with the maintenance page
# up from before the migrations until the new build is ready.
# Usage: deploy.sh <commit>, where <commit> is the tip of origin/main.
# Everything is inside main() so bash has read the whole script before the
# checkout below can replace this file.
set -euo pipefail

main() {
  local commit="${1:?Usage: deploy.sh <commit at the tip of origin/main>}"
  local run_dir="${JOBFLOW_RUN_DIR:-/home/prod/tax-invoice-run}"
  local flag="${JOBFLOW_MAINTENANCE_FLAG:-/var/lib/jobflow-maintenance/on}"
  local ready_url="${JOBFLOW_READY_URL:-http://127.0.0.1:3300/api/health/ready}"
  local attempts="${JOBFLOW_READY_ATTEMPTS:-60}"
  local delay="${JOBFLOW_READY_DELAY:-2}"

  if [ "$(id -u)" -eq 0 ]; then
    echo "Run this as prod, never root: a root deploy leaves root-owned files." >&2
    exit 1
  fi
  cd "$run_dir"
  git fetch --quiet origin main
  local target tip
  target="$(git rev-parse --verify "$commit^{commit}")"
  tip="$(git rev-parse origin/main)"
  if [ "$target" != "$tip" ]; then
    echo "Refusing: $target isn't the tip of origin/main ($tip). Nothing changed." >&2
    exit 1
  fi
  if ! sudo -n systemctl is-active jobflow.service >/dev/null; then
    echo "Note: jobflow.service isn't running before this deploy."
  fi

  # #359: a verified backup before anything changes, so a bad migration can
  # be rolled back (docs/ops/deployment.md, "Self-hosted site"). Exit 2 means
  # the backup was made locally but the Windows share was unreachable: still
  # a backup to roll back to. JOBFLOW_SKIP_BACKUP=1 deploys without one, for
  # a host where backups aren't installed yet.
  # The unit skips itself (without failing) while maintenance is on, so
  # success is judged by a complete backup newer than this deploy's start.
  local backups="${JOBFLOW_BACKUP_ROOT:-/home/prod/jobflow-backups}"
  local started newest
  started="$(date -u +%Y-%m-%dT%H%M%SZ)"
  if [ "${JOBFLOW_SKIP_BACKUP:-}" = 1 ]; then
    echo "Skipping the pre-deploy backup (JOBFLOW_SKIP_BACKUP=1)."
  else
    if sudo -n systemctl start jobflow-backup.service; then
      echo "Pre-deploy backup run finished."
    elif [ "$(systemctl show --property=ExecMainStatus --value jobflow-backup.service)" = 2 ]; then
      echo "Pre-deploy backup made locally; the share was unreachable, so it isn't on the share yet."
    else
      echo "The pre-deploy backup failed, or prod can't start it (run" >&2
      echo "infra/host/install.sh to update the deploy permission). Nothing changed." >&2
      echo "See: journalctl -u jobflow-backup.service -n 50" >&2
      exit 1
    fi
    newest="$(ls "$backups" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z$' | sort | tail -n 1 || true)"
    if [ -z "$newest" ] || [[ "$newest" < "$started" ]] || [ ! -f "$backups/$newest/manifest.json" ]; then
      echo "No new backup was made (is maintenance already on? the backup skips itself" >&2
      echo "then). Turn it off, or rerun with JOBFLOW_SKIP_BACKUP=1 if you accept" >&2
      echo "deploying without one. Nothing changed." >&2
      exit 1
    fi
    echo "Pre-deploy backup: $backups/$newest"
  fi

  # From here, any failure leaves the maintenance page on: the database may
  # already be newer than the old code, so it must not serve requests.
  trap 'echo "Deploy failed. Maintenance stays on. Fix it or roll back (docs/ops/deployment.md), then run: rm -f $flag" >&2' ERR
  touch "$flag"
  echo "Maintenance on."
  sudo -n systemctl stop jobflow.service
  # The build rewrites this tracked file, which would block the checkout.
  git checkout --quiet -- apps/web/next-env.d.ts
  git checkout --quiet --detach "$target"
  pnpm install --frozen-lockfile
  pnpm db:generate
  pnpm db:migrate
  pnpm build
  sudo -n systemctl start jobflow.service

  # Straight to the app: the public address shows maintenance until this passes.
  local try=0
  until curl -fsS --max-time 5 "$ready_url" >/dev/null 2>&1; do
    try=$((try + 1))
    if [ "$try" -ge "$attempts" ]; then
      echo "The new build didn't pass the readiness check." >&2
      false
    fi
    sleep "$delay"
  done

  rm -f "$flag"
  trap - ERR
  echo "Deployed $target. Maintenance off."
}

main "$@"
