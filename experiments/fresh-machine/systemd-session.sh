#!/usr/bin/env bash
#
# The half of a fresh-machine installation that run.sh cannot reach.
#
# run.sh proves that tracked source installs on a machine that has never seen this project, and stops
# where that machine has no systemd user session: the broker service, autostart, the shared budget and
# the private display are all out of reach there by construction. This one gives the container the
# missing half, systemd as PID 1 and a lingering account whose user manager owns delegated cpu, memory
# and pids controllers, and then asks the question that was left open: does ./install.sh run to
# completion, does the broker it starts answer, and does a session actually open.
#
# What it still cannot prove: hardware. There is no GPU, no real compositor and no display here, and
# the private display is headless wlroots either way, so this says nothing about a machine with a
# screen. It also inherits the host's processor and memory totals, so the budget it sizes is the
# host's quarter rather than the container's.
#
# It binds no ports, publishes nothing, touches no existing container or volume, and writes only to
# output/fresh-machine/ and a temporary directory of its own.
set -uo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../.." && pwd)
ref=${1:-HEAD}
image=sbar-orbit-systemd:fedora44
name=sbar-orbit-systemd-run
engine=$(command -v podman) || { echo "podman is required: this needs systemd as PID 1" >&2; exit 1; }

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$root/output/fresh-machine"
log=$root/output/fresh-machine/systemd-$stamp.log
work=$(mktemp -d)
cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1; rm -rf "$work"; }
trap cleanup EXIT

{
  echo "run: $stamp"
  "$engine" --version
  echo
  echo "=== source archive"
  git -C "$root" rev-parse "$ref"
  git -C "$root" archive --format=tar -o "$work/source.tar" "$ref" || exit 1
  sha256sum "$work/source.tar"
  echo
  echo "=== build"
  "$engine" build --tag "$image" --file "$here/Containerfile.systemd" "$here" || exit 1
  "$engine" image inspect --format '{{.Id}}' "$image"
  echo
  echo "=== boot"
  "$engine" rm -f "$name" >/dev/null 2>&1
  "$engine" run -d --name "$name" --systemd=always --cgroupns=private \
    -v "$work/source.tar:/mnt/source.tar:ro,Z" "$image" || exit 1
  # systemd needs a moment to reach its user manager; without linger nothing would start it at all.
  for _ in $(seq 1 30); do
    "$engine" exec -u orbit -e XDG_RUNTIME_DIR=/run/user/1000 "$name" \
      systemctl --user is-system-running >/dev/null 2>&1 && break
    sleep 1
  done
  echo "system: $("$engine" exec "$name" systemctl is-system-running 2>&1)"
  echo "user manager: $("$engine" exec -u orbit -e XDG_RUNTIME_DIR=/run/user/1000 "$name" systemctl --user is-system-running 2>&1)"
  echo
  echo "=== run"
  "$engine" cp "$here/inside-systemd.sh" "$name:/usr/local/bin/inside-systemd.sh"
  "$engine" exec -u root "$name" chmod 0755 /usr/local/bin/inside-systemd.sh
  "$engine" exec -u orbit -e HOME=/home/orbit "$name" /usr/local/bin/inside-systemd.sh
  inside=$?
  echo "--- inside exit: $inside"
  # The frame the native session captured, kept beside the log as the evidence for the gate.
  "$engine" cp "$name:/tmp/frame.jpg" "$root/output/fresh-machine/systemd-$stamp-frame.jpg" 2>/dev/null \
    && echo "frame: output/fresh-machine/systemd-$stamp-frame.jpg"
} 2>&1 | tee "$log"

echo
echo "log: $log"
