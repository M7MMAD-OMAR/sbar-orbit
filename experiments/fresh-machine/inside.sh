#!/usr/bin/env bash
# Runs inside the container as the unprivileged "orbit" account. Every step records its own exit
# status and the run continues, because two of these steps are expected to be non-zero here and a
# run that stops at the first one reports nothing.
#
# Expected non-zero on this host class, and recorded rather than worked around:
#   preflight          no browser is installed in the image
#   install.sh         its own guard refuses a machine with no usable systemd user session, and
#                      names a container as an expected case
#   local-install.ts   requireResourceBudget() needs an sbarorbit.slice cgroup, which a container
#                      with its own cgroup namespace and no systemd user session cannot have
set -uo pipefail

source_archive=${ORBIT_SOURCE_ARCHIVE:-/mnt/source.tar}
source_dir=$HOME/src
prefix=$HOME/.local
results=()

step() {
  local name=$1; shift
  echo
  echo "=== step: ${name}"
  echo "--- command: $*"
  "$@"
  local code=$?
  echo "--- exit ${name}: ${code}"
  results+=("${name} ${code}")
  return 0
}

echo "=== machine"
cat /etc/fedora-release
echo "kernel: $(uname -srm)"
echo "account: $(id -un) uid $(id -u)"
echo "bun: $(bun --version)"
echo "cgroup of this process:"
cat /proc/self/cgroup
echo "systemd user session: ${XDG_RUNTIME_DIR:-unset} / DBUS_SESSION_BUS_ADDRESS ${DBUS_SESSION_BUS_ADDRESS:-unset}"
echo "wayland: WAYLAND_DISPLAY ${WAYLAND_DISPLAY:-unset} / DISPLAY ${DISPLAY:-unset}"

mkdir -p "$source_dir"
step extract tar -xf "$source_archive" -C "$source_dir"
cd "$source_dir" || exit 1
step launcher-executable test -x ./bin/sbar-orbit

step bun-install bun install --frozen-lockfile --ignore-scripts
step preflight ./bin/sbar-orbit preflight
# The one command install, in the form that writes nothing first. Both forms are run because a
# refusal that only appears on a dry run would say nothing about the real one.
step install-sh-dry-run ./install.sh --dry-run
step install-sh ./install.sh
step local-install bun run scripts/local-install.ts install "$PWD" "$prefix"

if [ -e "$prefix/bin/sbar-orbit" ]; then
  step installed-help "$prefix/bin/sbar-orbit" --help
  step installed-doctor "$prefix/bin/sbar-orbit" doctor --report
else
  echo
  echo "=== step: installed-help"
  echo "--- not run: ${prefix}/bin/sbar-orbit does not exist, because the install above refused"
  results+=("installed-help not-run")
  # doctor --report is local and needs no broker, so it still runs from the source checkout. That
  # keeps the tier line this host class prints on the record even when the launcher link is absent.
  step source-doctor ./bin/sbar-orbit doctor --report
fi

echo
echo "=== summary"
for line in "${results[@]}"; do echo "  $line"; done
