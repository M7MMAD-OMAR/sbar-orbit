#!/usr/bin/env bash
#
# The Linux families docs/porting.md names and this project has no machine for, run as containers:
# Debian stable, Ubuntu LTS, Arch and openSUSE Tumbleweed. Each container gets the bundled runtime
# this workstation built (sway, wlroots and the pointer helper from three Fedora packages, without
# the rpms) and answers G1, G2, G5 and G29 from experiments/linux-families/inside.sh.
#
# What a container can say: whether the Fedora built compositor loads and runs on that family's libc
# and library set, whether the family's own sway starts from a private prefix, whether the compositor
# needs a logind session, and whether unprivileged user namespaces plus socat give the confined
# egress shape. What it cannot say: anything about a screen, a GPU, a systemd user session or the
# broker, none of which exist here. A pass is tier Limited for that family, never Measured.
#
# It binds no ports, publishes nothing, touches no existing container or volume, and writes only to
# output/linux-families/ and a temporary directory of its own.
#
# Usage: experiments/linux-families/run.sh [family ...]   (default: debian ubuntu arch opensuse)
set -uo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../.." && pwd)
families=("$@"); [ ${#families[@]} -eq 0 ] && families=(debian ubuntu arch opensuse)
engine=$(command -v podman || command -v docker) || { echo "Neither podman nor docker is available" >&2; exit 1; }
data=${XDG_DATA_HOME:-$HOME/.local/share}
runtime=$(ls -d "$data"/sbar-orbit/runtime/sway-*/ 2>/dev/null | head -1)
[ -n "$runtime" ] && [ -x "$runtime/root/usr/bin/sway" ] || { echo "No built native runtime under $data/sbar-orbit/runtime; run ./install.sh --native first" >&2; exit 1; }
stamp=$(date +%Y%m%d-%H%M%S)
out=$root/output/linux-families; mkdir -p "$out"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
# The rpms are the download, not the runtime; everything else in the directory is what a session uses.
tar -cf "$work/runtime.tar" -C "$runtime" --exclude=rpms .
echo "runtime: $runtime ($(du -sh "$work/runtime.tar" | cut -f1))"
summary=()
for family in "${families[@]}"; do
  log=$out/$family-$stamp.log
  {
    echo "run: $stamp family: $family engine: $engine"
    echo "runtime: $runtime"; sha256sum "$work/runtime.tar"
    echo "=== build"
    "$engine" build --tag "sbar-orbit-family:$family" --file "$here/Containerfile.$family" "$here" || { echo "--- build failed"; exit 1; }
    "$engine" image inspect --format 'image: {{.Id}}' "sbar-orbit-family:$family"
    echo "=== run"
    name=sbar-orbit-family-$family-$stamp
    # Bounded: a probe that hangs inside is a finding, not a reason for the run to wait all day.
    timeout --signal=KILL 900 "$engine" run --name "$name" --volume "$work/runtime.tar:/mnt/runtime.tar:ro,Z" "sbar-orbit-family:$family"
    echo "--- container exit: $?"
    "$engine" cp "$name:/tmp/report.json" "$out/$family-$stamp.json" 2>/dev/null && echo "report: output/linux-families/$family-$stamp.json"
    # The captured frames, kept beside the log as the evidence for the smoke probe.
    mkdir -p "$work/$family" && "$engine" cp "$name:/tmp/." "$work/$family/" >/dev/null 2>&1
    for f in "$work/$family"/frame-*.png; do
      [ -f "$f" ] && cp "$f" "$out/$family-$stamp-$(basename "$f")" && echo "frame: output/linux-families/$family-$stamp-$(basename "$f")"
    done
    "$engine" rm -f "$name" >/dev/null 2>&1
  } 2>&1 | tee "$log"
  if [ -f "$out/$family-$stamp.json" ]; then
    summary+=("$(/usr/bin/python3 "$here/summary.py" "$out/$family-$stamp.json")")
  else
    summary+=("$family: no report")
  fi
done
echo; echo "=== summary $stamp"; printf '%s\n' "${summary[@]}"
