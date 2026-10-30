#!/usr/bin/env bash
# Build against the extracted Fedora headers; never install into the host.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
INCLUDE=${ORBIT_PLUGIN_INCLUDE:-"$HERE/.deps/usr/include"}
OUT=${1:-"$HERE/ghostinput.so"}
if ! test -f "$INCLUDE/hyprland/src/plugins/PluginAPI.hpp"; then
  echo "build.sh: no Hyprland plugin headers under $INCLUDE" >&2
  echo "  Extract the hyprland-devel package that matches the RUNNING compositor into $HERE/.deps (dnf download hyprland-devel-VERSION; rpm2cpio FILE | cpio -idmv)." >&2
  exit 2
fi
# The headers must be the running compositor's own build, or the plugin loads against the wrong ABI.
HEADER_COMMIT=$(sed -n 's/^#define GIT_COMMIT_HASH *"\([0-9a-f]\{40\}\)".*/\1/p' "$INCLUDE/hyprland/src/version.h" 2>/dev/null | head -1)
RUNNING_COMMIT=$(hyprctl version 2>/dev/null | sed -n 's/.* at commit \([0-9a-f]\{40\}\).*/\1/p' | head -1)
if [ -n "$HEADER_COMMIT" ] && [ -n "$RUNNING_COMMIT" ] && [ "$HEADER_COMMIT" != "$RUNNING_COMMIT" ]; then
  echo "build.sh: headers are for Hyprland commit ${HEADER_COMMIT:0:12} but the running compositor is ${RUNNING_COMMIT:0:12}." >&2
  echo "  Extract hyprland-devel for the running version into $HERE/.deps, or log out and in if the installed package is newer." >&2
  exit 3
fi
# Under the owner's home, never the small /tmp tmpfs.
BUILD_TMP=${ORBIT_BUILD_TMP:-"$HOME/.cache/sbar-orbit/build"}
mkdir -p "$BUILD_TMP"
SNAPSHOT=$(mktemp "$BUILD_TMP/ghostinput-build-XXXXXX.cpp")
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
