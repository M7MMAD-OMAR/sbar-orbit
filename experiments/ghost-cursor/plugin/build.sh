#!/usr/bin/env bash
# Build against the extracted Fedora headers; never install into the host.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
INCLUDE="$HERE/.deps/usr/include"
OUT=${1:-"$HERE/ghostinput.so"}
test -f "$INCLUDE/hyprland/src/plugins/PluginAPI.hpp"
SNAPSHOT=$(mktemp /tmp/ghostinput-build-XXXXXX.cpp)
trap 'rm -f "$SNAPSHOT"' EXIT
cp "$HERE/ghostinput.cpp" "$SNAPSHOT"
sha256sum "$SNAPSHOT" > "$OUT.source.sha256"
SOURCE_SHA256=$(sha256sum "$SNAPSHOT")
SOURCE_SHA256=${SOURCE_SHA256%% *}
[[ "$SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]]
# GNU-unique template statics keep a DSO mapped after dlclose.
g++ -std=c++23 -shared -fPIC -fno-gnu-unique -O0 \
  "-DORBIT_PLUGIN_SOURCE_SHA256=\"$SOURCE_SHA256\"" \
  -I"$INCLUDE" -I"$INCLUDE/hyprland" -I"$INCLUDE/hyprland/src" -I"$INCLUDE/hyprland/protocols" \
  $(pkg-config --cflags pixman-1 libdrm cairo libinput xkbcommon wayland-server) \
  "$SNAPSHOT" -o "$OUT"
printf 'Built %s\n' "$OUT"
