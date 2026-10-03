#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DEPS="$HERE/plugin/.deps"
test -f "$DEPS/virtual-pointer.xml"
wayland-scanner client-header "$DEPS/virtual-pointer.xml" "$DEPS/virtual-pointer-client.h"
wayland-scanner private-code "$DEPS/virtual-pointer.xml" "$DEPS/virtual-pointer-protocol.c"
cc -Wall -Wextra -O0 -I"$DEPS" $(pkg-config --cflags wayland-client) \
  "$HERE/person_pointer.c" "$DEPS/virtual-pointer-protocol.c" \
  $(pkg-config --libs wayland-client) -o "$DEPS/person-pointer"
