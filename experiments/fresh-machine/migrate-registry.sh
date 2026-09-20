#!/usr/bin/env bash
# Transition from the actual published alpha.6 package to the candidate archive on a disposable host.
set -euo pipefail
archive=$(realpath -- "${1:?Pass the registry tarball}")
name="orbit-migration-gate-$(date +%s)-$$"
trap 'podman rm -f "$name" >/dev/null 2>&1 || true' EXIT
podman run -d --name "$name" --systemd=always --cgroupns=private localhost/sbar-orbit-systemd:fedora44
guest_home=$(podman exec "$name" getent passwd orbit | cut -d: -f6)
podman cp "$archive" "$name:/tmp/release.tgz"
for attempt in $(seq 1 30); do
  if podman exec -u orbit -e XDG_RUNTIME_DIR=/run/user/1000 "$name" systemctl --user is-system-running >/dev/null 2>&1; then break; fi
  sleep 1
done
podman exec -u orbit -e HOME="$guest_home" -e XDG_RUNTIME_DIR=/run/user/1000 "$name" bash -lc '
set -euo pipefail
cd "$HOME"
bun add -g sbar-orbit@0.1.0-alpha.6
"$HOME/.bun/bin/sbar-orbit" install --json > /tmp/old-install.json
"$HOME/.local/bin/sbar-orbit" doctor > /tmp/old-doctor.json
printf "PASS: published alpha.6 installed and broker answered\n"
mkdir -p "$HOME/.local/state/sbar-orbit"
printf "retained migration state" > "$HOME/.local/state/sbar-orbit/migration-sentinel"
systemctl --user stop sbar-orbit.service
bun add -g sbar-orbit@file:/tmp/release.tgz
"$HOME/.bun/bin/sbar-orbit" install --managed --json > /tmp/new-install.json
"$HOME/.local/bin/sbar-orbit" doctor > /tmp/new-doctor.json
"$HOME/.local/bin/sbar-orbit" update status > /tmp/update-status.json
python3 - <<"PY"
import json
from pathlib import Path
status=json.load(open("/tmp/update-status.json"))
assert status["managed"] and status["current"] == "0.1.0-alpha.8", status
assert (Path.home()/".local/state/sbar-orbit/migration-sentinel").read_text() == "retained migration state"
print("PASS: registry alpha.6 migrated to managed alpha.8 and retained state")
PY
'
