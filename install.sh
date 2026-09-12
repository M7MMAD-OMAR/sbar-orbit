#!/usr/bin/env bash
# The whole installation, from a fresh checkout, in one command:
#
#   ./install.sh
#
# It links the sbar-orbit command, prepares dependencies, installs and starts the broker service,
# writes the agent connector configuration and verifies that the broker answers. It installs nothing
# that needs root: Bun, Chrome and the Fedora capture tools stay the package manager's job, and the
# run prints the exact command for each one it finds missing.
set -euo pipefail
cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'MISSING'
Orbit runs on Bun, and this machine does not have it yet.

  curl -fsSL https://bun.sh/install | bash

Then open a new shell and run ./install.sh again.
MISSING
  exit 1
fi

exec bun run scripts/limited.ts bun run scripts/install.ts "$@"
