#!/usr/bin/env bash
#
# Fresh-machine installation, the unprivileged half, in a clean Fedora 44 container.
#
# What this proves: that a machine which has never seen this project can take the tracked source,
# a pinned Bun and the committed lockfile, resolve dependencies with scripts ignored, and run the
# read-only commands. It also proves exactly where both install paths stop on a host without a
# systemd user session: the one command installer refuses with its own guard and names the reason,
# and the launcher link install refuses on the resource budget.
#
# What this cannot prove: any part of gate 3 that needs the real host. A container has no systemd
# user session, no cgroup delegation, no wlroots compositor and no browser, so the broker service,
# autostart, the native display and the shared resource budget are never exercised. A pass here is
# at most "Limited" under docs/support-tiers.md, never "Measured".
#
# It binds no ports, publishes nothing, touches no existing container or volume, and writes only
# to output/fresh-machine/ and a temporary directory of its own. The source reaches the container
# as a git archive of tracked files, so node_modules is never copied in.
#
# Two passes run from one Containerfile. "minimal" is a bare Fedora 44 with only Bun, which is the
# honest fresh-machine starting point. "deps" adds the packages a person would install by hand, so
# preflight's browser group is exercised rather than assumed.
#
# Usage: experiments/fresh-machine/run.sh [git-ref]

set -uo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../.." && pwd)
ref=${1:-HEAD}
image=sbar-orbit-fresh-machine

engine=$(command -v podman || command -v docker) || {
  echo "Neither podman nor docker is available" >&2; exit 1
}
echo "engine: $engine"

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$root/output/fresh-machine"
log=$root/output/fresh-machine/run-$stamp.log

work=$(mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

{
  echo "run: $stamp"
  echo "engine: $engine"
  "$engine" --version

  # No port is bound by this experiment. The listener table is recorded before and after anyway, so
  # an accidental listener would be visible. Several agents share this workstation, so a difference
  # between the two tables is not by itself attributable to this run.
  echo
  echo "=== listeners before"
  ss -ltn

  echo
  echo "=== source archive"
  git -C "$root" rev-parse "$ref"
  git -C "$root" archive --format=tar -o "$work/source.tar" "$ref" || exit 1
  sha256sum "$work/source.tar"
  tar -tf "$work/source.tar" | wc -l

  echo "base image digest:"
  "$engine" image inspect --format '{{.Digest}}' docker.io/library/fedora:44

  for variant in minimal deps; do
    with_deps=0
    [ "$variant" = deps ] && with_deps=1
    tag=$image:fedora44-$variant

    echo
    echo "=== build ($variant)"
    "$engine" build --tag "$tag" --build-arg "WITH_DEPS=$with_deps" \
      --file "$here/Containerfile" "$here" || continue
    echo "built image id ($variant):"
    "$engine" image inspect --format '{{.Id}}' "$tag"

    echo
    echo "=== run ($variant)"
    # No --publish, no host namespace, no host path but the read-only source archive.
    "$engine" run --rm \
      --name "sbar-orbit-fresh-machine-$variant-$stamp" \
      --volume "$work/source.tar:/mnt/source.tar:ro,Z" \
      "$tag"
    echo "--- container exit ($variant): $?"
  done

  echo
  echo "=== listeners after"
  ss -ltn
} 2>&1 | tee "$log"

echo
echo "log: $log"
