#!/bin/sh
# Shared by sync.sh and install.sh (#353). Sourced, not run.

# True when an SMB/CIFS share is mounted at $1. A plain mountpoint test isn't
# enough: with x-systemd.automount, systemd keeps an autofs mount there even
# while the Windows computer is off. Touching the folder first starts the
# on-demand mount, bounded because a CIFS attempt to a sleeping computer can
# hang; findmnt itself never blocks.
share_mounted() {
  timeout 60 ls "$1" >/dev/null 2>&1 || true
  findmnt -rn -t cifs,smb3 -M "$1" >/dev/null 2>&1
}
