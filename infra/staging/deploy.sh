#!/bin/sh
# Staging host deploy entry point (#64). Install as the SSH forced command for
# the CI deploy key, so that key can do exactly one thing:
#   command="/opt/jobflow/infra/staging/deploy.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… ci-staging
# It deploys only a commit that is already on origin/main.
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
git fetch --quiet origin main
git merge-base --is-ancestor "$SHA" origin/main || { echo "commit is not on main" >&2; exit 65; }
git -c advice.detachedHead=false checkout --quiet --detach "$SHA"

compose() {
  docker compose -f infra/staging/compose.yml --env-file infra/staging/env/compose.env "$@"
}
compose build migrate web
compose up -d --wait postgres
# Migrations and grants first; a failure stops here with the old app running.
compose run --rm migrate
compose up -d --no-deps --wait --wait-timeout 300 web nginx
echo "deployed $SHA"
