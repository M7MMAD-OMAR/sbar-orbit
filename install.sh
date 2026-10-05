#!/usr/bin/env bash
# The whole installation, from a fresh checkout, in one command:
#
#   ./install.sh
#
# It links the sbar-orbit command, prepares dependencies, installs and starts the broker service,
# writes the agent connector configuration and verifies that the broker answers. It installs nothing
# that needs root: Bun, a browser and the capture tools stay the package manager's job, and the
# run prints the exact command for each one it finds missing.
set -euo pipefail
# BSD readlink has no portable -f flag. Resolve each link from its own directory,
# including relative package-manager links, before selecting the source directory.
orbit_script=${BASH_SOURCE[0]}
for ((orbit_link_count=0; ; orbit_link_count++)); do
  orbit_directory=$(cd -P -- "$(dirname -- "$orbit_script")" && pwd) || exit 1
  orbit_script="$orbit_directory/$(basename -- "$orbit_script")"
  [ -L "$orbit_script" ] || break
  if [ "$orbit_link_count" -ge 40 ]; then
    echo "Orbit installer: too many symbolic links" >&2
    exit 1
  fi
  orbit_target=$(readlink "$orbit_script") || exit 1
  case "$orbit_target" in
    /*) orbit_script=$orbit_target ;;
    *) orbit_script="$orbit_directory/$orbit_target" ;;
  esac
done
cd -P -- "$orbit_directory"

orbit_bun=$(command -v bun 2>/dev/null || true)
for orbit_candidate in "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do
  if [ -z "$orbit_bun" ] && [ -x "$orbit_candidate" ]; then orbit_bun=$orbit_candidate; fi
done
if [ -z "$orbit_bun" ]; then
  cat >&2 <<'MISSING'
Orbit runs on Bun, and this machine does not have it yet.

  curl -fsSL https://bun.sh/install | bash

Then open a new shell and run ./install.sh again.
MISSING
  exit 1
fi
export PATH="$(dirname -- "$orbit_bun"):$PATH"

# Orbit runs everything inside a shared resource budget, the installer included, and what provides
# that budget differs by platform. On Linux it is a systemd user slice; without a usable user session
# there is nothing to install into, and the budget refusal that follows reads like a crash to somebody
# who has just downloaded this. On macOS it is a registered process group, which needs no session
# manager and no configuration at all, so the check below does not apply there.
if [ "$(uname -s)" != "Darwin" ] && ! systemctl --user show-environment >/dev/null 2>&1; then
  cat >&2 <<'NOSYSTEMD'
This machine has no usable systemd user session.

Orbit keeps every process it owns, the installer included, inside a shared CPU and memory budget on a
systemd user slice. Without that session there is nothing to install into, so this stops here rather
than installing something that cannot start.

This is the expected result inside a container, over a bare ssh session with no lingering user
manager, and on a Linux system that does not use systemd. On a normal desktop login it should work;
if it does not, `systemctl --user status` is the place to look.

The read-only check still runs anywhere:

  ./bin/sbar-orbit preflight
NOSYSTEMD
  exit 1
fi

exec "$orbit_bun" run scripts/limited.ts bun run scripts/install.ts "$@"
