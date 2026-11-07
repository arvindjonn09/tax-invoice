#!/usr/bin/env bash
# Turn the JobFlow maintenance page on or off by hand (#326).
set -euo pipefail
flag="${JOBFLOW_MAINTENANCE_FLAG:-/var/lib/jobflow-maintenance/on}"
case "${1:-status}" in
  on) touch "$flag"; echo "Maintenance is on." ;;
  off) rm -f "$flag"; echo "Maintenance is off." ;;
  status) if [ -e "$flag" ]; then echo "Maintenance is on."; else echo "Maintenance is off."; fi ;;
  *) echo "Usage: maintenance.sh on|off|status" >&2; exit 2 ;;
esac
