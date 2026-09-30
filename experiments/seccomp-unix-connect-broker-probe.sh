#!/usr/bin/env bash
set -euo pipefail

probe_bin="$(mktemp /var/tmp/orbit-seccomp.XXXXXX)"
cleanup() {
  /usr/bin/python3 - "$probe_bin" <<'PY'
import pathlib
import sys

pathlib.Path(sys.argv[1]).unlink(missing_ok=True)
PY
}
trap cleanup EXIT
ulimit -c 0

cc -Wall -Wextra -O2 -pthread -o "$probe_bin" \
  experiments/seccomp-unix-connect-broker-probe.c
"$probe_bin" "$@"
