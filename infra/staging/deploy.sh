#!/bin/sh
# Staging host deploy entry point (#64). Install a root-owned copy OUTSIDE the
# checkout, so a deploy can't replace its own gate:
#   sudo install -o root -g root -m 0755 infra/staging/deploy.sh /usr/local/sbin/jobflow-deploy
# and make it the SSH forced command for the CI deploy key:
#   restrict,command="/usr/local/sbin/jobflow-deploy" ssh-ed25519 AAAA… ci-staging
# It deploys only the commit that is the current tip of origin/main: never
# an older one (rollbacks are a revert commit, or done by the owner on the host).
set -euf

REPO=${JOBFLOW_REPO:-/opt/jobflow}
set -- ${SSH_ORIGINAL_COMMAND:-}
if [ "$#" -ne 2 ] || [ "$1" != deploy ]; then
  echo "usage: deploy <commit sha>" >&2
  exit 64
fi
SHA=$2
case "$SHA" in
  *[!0-9a-f]*) echo "invalid commit" >&2; exit 64 ;;
esac
[ "${#SHA}" -eq 40 ] || { echo "invalid commit" >&2; exit 64; }

cd "$REPO"
# #136: the ClamAV image must be pinned by digest (compose.env is host-only).
CLAMAV_IMAGE=$(sed -n 's/^CLAMAV_IMAGE=//p' infra/staging/env/compose.env | tail -n 1)
if ! printf '%s\n' "$CLAMAV_IMAGE" | grep -Eq '^clamav/clamav:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$'; then
  echo "CLAMAV_IMAGE in compose.env must be clamav/clamav:<tag>@sha256:<digest>" >&2
  exit 66
fi
git fetch --quiet origin main
if [ "$SHA" != "$(git rev-parse origin/main)" ]; then
  # A newer main commit has its own deploy; this one is superseded.
  if git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
    echo "superseded by a newer main commit; nothing to do"
    exit 0
  fi
  echo "commit is not the tip of main" >&2
  exit 65
fi
git -c advice.detachedHead=false checkout --quiet --detach "$SHA"

compose() {
  docker compose -f infra/staging/compose.yml --env-file infra/staging/env/compose.env "$@"
}
compose build migrate web
# The backup image too (#173): it carries this release's backup CLI, and its
# Compose profile needs backup.env, so build it directly under the same tag.
docker build --quiet -f apps/web/Dockerfile --target backup -t jobflow-backup:staging . >/dev/null
compose up -d --wait postgres
# Migrations and grants first; a failure stops here with the old app running.
compose run --rm migrate
# Malware scanning (#136) before the app: `--no-deps` below would never start
# it, and the app refuses uploads without it. The first start downloads the
# signature database, hence the long wait. A changed image is rolled out here.
compose up -d --wait --wait-timeout 900 clamav
compose up -d --no-deps --wait --wait-timeout 300 web
# Recreate nginx so it re-renders its templates and picks up the new web
# container (its upstream also re-resolves, but a fresh start is certain).
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 nginx
echo "deployed $SHA"
