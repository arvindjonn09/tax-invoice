#!/bin/sh
# Installs the pinned gitleaks for the secret scan. GitHub release downloads
# sometimes fail with a 504 or a dropped HTTP/2 stream, so the download is
# retried with backoff (HTTP/1.1, bounded time). The checksum is checked on
# whatever arrives, and a download that never succeeds still fails the job:
# secret scanning is never skipped.
set -eu
url=https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
attempt=1
until curl --fail --silent --show-error --location --http1.1 \
  --connect-timeout 20 --max-time 120 \
  --retry 3 --retry-all-errors --retry-delay 5 \
  "$url" -o "$archive"; do
  if [ "$attempt" -ge 4 ]; then
    echo "gitleaks download failed after $attempt attempts" >&2
    exit 1
  fi
  echo "gitleaks download failed (attempt $attempt); retrying in $((attempt * 15))s" >&2
  sleep $((attempt * 15))
  attempt=$((attempt + 1))
done
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check
tar -xzf "$archive" -C "${RUNNER_TEMP:-/tmp}" gitleaks
