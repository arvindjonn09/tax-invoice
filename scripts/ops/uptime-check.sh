#!/bin/sh
# #357: is the public site up? Asks /api/health/ready (the app answers 200
# only when its database and storage are ready). Usage:
#   sh scripts/ops/uptime-check.sh https://jobflow.shivomsangha.com
# Exits 0 when ready. A failure is retried for up to about 2 minutes, so one
# dropped request doesn't alert. The maintenance page (503 with
# "code":"maintenance") is waited out for up to 10 minutes: deploys use it.
# Exits 1 if the site still isn't ready. Prints status lines only; no secrets.
set -u
base="${1:?Usage: uptime-check.sh https://host}"
url="$base/api/health/ready"
deadline_down=$(( $(date +%s) + 120 ))
deadline_maintenance=$(( $(date +%s) + 600 ))
while :; do
  body=$(curl --silent --show-error --max-time 15 --write-out '\n%{http_code}' "$url" 2>&1)
  code=$(printf '%s' "$body" | tail -n 1)
  now=$(date +%s)
  if [ "$code" = 200 ]; then
    echo "OK: $url answered 200"
    exit 0
  fi
  if [ "$code" = 503 ] && printf '%s' "$body" | grep -Eq '"code": *"maintenance"'; then
    if [ "$now" -ge "$deadline_maintenance" ]; then
      echo "DOWN: maintenance page for over 10 minutes at $url" >&2
      exit 1
    fi
    echo "maintenance page (a deploy?); checking again in 25 s"
  elif [ "$now" -ge "$deadline_down" ]; then
    echo "DOWN: $url answered ${code:-no response} for over 2 minutes" >&2
    exit 1
  else
    echo "not ready (${code:-no response}); checking again in 25 s"
  fi
  sleep 25
done
