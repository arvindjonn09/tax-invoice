#!/usr/bin/env bash
# Tests the gate and deploy script on a local copy (#326), with no root and
# nothing on the real host touched. A fake app stands in for JobFlow.
# Usage: test-gate.sh [path to nginx]   (needs nginx, node, curl and git)
set -euo pipefail
nginx_bin="${1:-nginx}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
gate_port=38299
app_port=38300
fails=0
app_pid=""
cleanup() {
  [ -f "$tmp/nginx.pid" ] && kill "$(cat "$tmp/nginx.pid")" 2>/dev/null || true
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "ok    $1"
  else echo "FAIL  $1: expected [$2], got [$3]"; fails=$((fails + 1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
type_of() { curl -s -o /dev/null -w '%{content_type}' "$@"; }
gate="http://127.0.0.1:$gate_port"

cat >"$tmp/app.mjs" <<APP
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
createServer((req, res) => {
  appendFileSync("$tmp/app.log", req.method + " " + req.url + "\n");
  if (req.url === "/api/own-503") {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end('{"error":"from the app"}');
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ host: req.headers.host, ip: req.headers["cf-connecting-ip"] }));
}).listen($app_port, "127.0.0.1");
APP
start_app() {
  node "$tmp/app.mjs" &
  app_pid=$!
  for _ in $(seq 50); do
    curl -s -o /dev/null "http://127.0.0.1:$app_port/ready" && return
    sleep 0.1
  done
}

mkdir -p "$tmp/www" "$tmp/state"
cp "$here/maintenance/"* "$tmp/www/"
sed -e "s#127.0.0.1:3299#127.0.0.1:$gate_port#" \
    -e "s#127.0.0.1:3300#127.0.0.1:$app_port#" \
    -e "s#/var/lib/jobflow-maintenance/on#$tmp/state/on#" \
    -e "s#/usr/share/jobflow-maintenance#$tmp/www#" \
    "$here/nginx-gate.conf" >"$tmp/gate.conf"
cat >"$tmp/nginx.conf" <<CONF
daemon on;
pid $tmp/nginx.pid;
error_log $tmp/error.log;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path $tmp/body;
  proxy_temp_path $tmp/proxy;
  fastcgi_temp_path $tmp/fastcgi;
  uwsgi_temp_path $tmp/uwsgi;
  scgi_temp_path $tmp/scgi;
  include $tmp/gate.conf;
}
CONF
"$nginx_bin" -e "$tmp/error.log" -p "$tmp" -c "$tmp/nginx.conf"
start_app

echo "--- maintenance off"
check "a page reaches the app" 200 "$(status "$gate/")"
check "the host and client IP pass through" \
  '{"host":"jobflow.invalid","ip":"203.0.113.9"}' \
  "$(curl -s -H 'Host: jobflow.invalid' -H 'CF-Connecting-IP: 203.0.113.9' "$gate/")"
check "the app's own 503 is left alone" '{"error":"from the app"}' "$(curl -s "$gate/api/own-503")"
check "the error page can't be requested directly" 404 "$(status "$gate/__jobflow_unavailable/index.html")"

echo "--- maintenance on"
JOBFLOW_MAINTENANCE_FLAG="$tmp/state/on" "$here/maintenance.sh" on >/dev/null
: >"$tmp/app.log"
check "a page is 503" 503 "$(status "$gate/jobs")"
check "a page is HTML" "text/html" "$(type_of "$gate/jobs")"
check "a page says we'll be back" 1 "$(curl -s "$gate/" | grep -c "We'll be back soon")"
check "an API GET is 503" 503 "$(status "$gate/api/jobs")"
check "an API call is JSON" "application/json" "$(type_of "$gate/api/jobs?x=1")"
check "an API POST is 503, not 405" 503 "$(status -X POST -d '{}' "$gate/api/jobs")"
check "a form POST is 503, not 405" 503 "$(status -X POST -d 'a=1' "$gate/login")"
check "Retry-After is sent" "120" "$(curl -sI "$gate/" | tr -d '\r' | awk 'tolower($1)=="retry-after:"{print $2}')"
check "it isn't cached" "no-store" "$(curl -sI "$gate/" | tr -d '\r' | awk 'tolower($1)=="cache-control:"{print $2}')"
check "no request reached the app" 0 "$(wc -l <"$tmp/app.log" | tr -d ' ')"

echo "--- maintenance off again"
JOBFLOW_MAINTENANCE_FLAG="$tmp/state/on" "$here/maintenance.sh" off >/dev/null
check "a page reaches the app" 200 "$(status "$gate/")"

echo "--- app stopped, maintenance off"
kill "$app_pid"; wait "$app_pid" 2>/dev/null || true; app_pid=""
check "a page is 503, not 502" 503 "$(status "$gate/")"
check "a page is HTML" "text/html" "$(type_of "$gate/")"
check "an API call is JSON" "application/json" "$(type_of "$gate/api/jobs")"
check "an API POST is 503, not 502" 503 "$(status -X POST -d '{}' "$gate/api/jobs")"
start_app
check "the site returns by itself" 200 "$(status "$gate/")"

echo "--- deploy script"
repo="$tmp/repo"
git init -q --bare "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$repo" 2>/dev/null
mkdir -p "$repo/apps/web"
git -C "$repo" -c user.name=t -c user.email=t@jobflow.invalid checkout -q -b main
echo a >"$repo/apps/web/next-env.d.ts"
git -C "$repo" add -A
git -C "$repo" -c user.name=t -c user.email=t@jobflow.invalid commit -qm one
git -C "$repo" push -q origin main
old="$(git -C "$repo" rev-parse HEAD)"
echo b >"$repo/next"
git -C "$repo" add -A
git -C "$repo" -c user.name=t -c user.email=t@jobflow.invalid commit -qm two
git -C "$repo" push -q origin main
new="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" checkout -q --detach "$old"
echo edited >"$repo/apps/web/next-env.d.ts"

mkdir -p "$tmp/bin"
cat >"$tmp/bin/sudo" <<STUB
#!/bin/sh
shift
echo "systemctl \$2" >>"$tmp/steps"
[ "\$2" = "start" ] && [ -e "$tmp/state/on" ] && echo "flag-on-at-start" >>"$tmp/steps"
exit 0
STUB
cat >"$tmp/bin/pnpm" <<STUB
#!/bin/sh
echo "pnpm \$1" >>"$tmp/steps"
[ -e "$tmp/state/on" ] || echo "flag-off-during-pnpm" >>"$tmp/steps"
exit 0
STUB
chmod +x "$tmp/bin/sudo" "$tmp/bin/pnpm"
deploy() {
  PATH="$tmp/bin:$PATH" JOBFLOW_RUN_DIR="$repo" JOBFLOW_MAINTENANCE_FLAG="$tmp/state/on" \
    JOBFLOW_READY_ATTEMPTS=2 JOBFLOW_READY_DELAY=0 JOBFLOW_READY_URL="$1" \
    "$here/deploy.sh" "$2" >/dev/null 2>&1
}

: >"$tmp/steps"
code=0; deploy "http://127.0.0.1:$app_port/" "$old" || code=$?
check "an older commit is refused" 1 "$code"
check "a refused commit doesn't turn maintenance on" no "$([ -e "$tmp/state/on" ] && echo yes || echo no)"
check "a refused commit changes nothing" "" "$(cat "$tmp/steps")"

: >"$tmp/steps"
code=0; deploy "http://127.0.0.1:1/" "$new" || code=$?
check "a failed readiness check fails the deploy" 1 "$code"
check "a failed readiness check leaves maintenance on" yes "$([ -e "$tmp/state/on" ] && echo yes || echo no)"
check "the page still shows after a failed check" 503 "$(status "$gate/")"
rm -f "$tmp/state/on"

git -C "$repo" checkout -q --detach "$old"
echo edited >"$repo/apps/web/next-env.d.ts"
: >"$tmp/steps"
code=0; deploy "http://127.0.0.1:$app_port/" "$new" || code=$?
check "a good deploy succeeds" 0 "$code"
check "a good deploy turns maintenance off" no "$([ -e "$tmp/state/on" ] && echo yes || echo no)"
check "it deployed the commit" "$new" "$(git -C "$repo" rev-parse HEAD)"
check "steps run in order, with the page up throughout" \
  "systemctl is-active,systemctl stop,pnpm install,pnpm db:generate,pnpm db:migrate,pnpm build,systemctl start,flag-on-at-start" \
  "$(paste -sd, "$tmp/steps")"

echo
if [ "$fails" -eq 0 ]; then echo "All gate checks passed."; else echo "$fails check(s) failed."; exit 1; fi
