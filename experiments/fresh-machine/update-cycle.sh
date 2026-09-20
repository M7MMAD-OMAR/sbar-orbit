#!/usr/bin/env bash
# Isolated upgrade gate. Requires the existing Containerfile.systemd image and a registry tarball.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
archive=$(realpath -- "${1:?Pass the registry tarball}")
name="orbit-update-gate-$(date +%s)-$$"
trap 'podman rm -f "$name" >/dev/null 2>&1 || true' EXIT
podman run -d --name "$name" --systemd=always --cgroupns=private localhost/sbar-orbit-systemd:fedora44
guest_home=$(podman exec "$name" getent passwd orbit | cut -d: -f6)
podman cp "$archive" "$name:/tmp/release.tgz"
podman cp "$here/update-cycle.ts" "$name:/tmp/update-cycle.ts"
for attempt in $(seq 1 30); do
  if podman exec -u orbit -e XDG_RUNTIME_DIR=/run/user/1000 "$name" systemctl --user is-system-running >/dev/null 2>&1; then break; fi
  sleep 1
done
podman exec -u orbit -e HOME="$guest_home" -e XDG_RUNTIME_DIR=/run/user/1000 -e ORBIT_UPDATE_CONTAINER=1 "$name" bash -lc '
set -euo pipefail
mkdir -p "$HOME/release"
tar xzf /tmp/release.tgz -C "$HOME/release" --strip-components=1
cd "$HOME/release"
bun install --frozen-lockfile --ignore-scripts
./install.sh --managed --json > /tmp/managed-install.json
mkdir -p experiments/fresh-machine
cp /tmp/update-cycle.ts experiments/fresh-machine/update-cycle.ts
bun run scripts/limited.ts bun experiments/fresh-machine/update-cycle.ts
'
