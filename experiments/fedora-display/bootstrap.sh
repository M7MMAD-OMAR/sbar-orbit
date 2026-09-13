#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# ORBIT_RUNTIME_DIR lets the installer and its tests build somewhere other than the live runtime.
runtime="${ORBIT_RUNTIME_DIR:-$PWD/.runtime/sway}"
mkdir -p "$runtime/rpms" "$runtime/root"
# Download Fedora packages without installing them or enabling any services.
dnf download --destdir "$runtime/rpms" sway-1.11-3.fc44.x86_64 wlroots0.19-0.19.3-1.fc44.x86_64 libliftoff-0.5.0-5.fc44.x86_64
for package in sway-1.11-3.fc44.x86_64 wlroots0.19-0.19.3-1.fc44.x86_64 libliftoff-0.5.0-5.fc44.x86_64; do
  (cd "$runtime/root" && rpm2cpio "$runtime/rpms/$package.rpm" | cpio -idu --quiet)
done
curl -fsSL https://raw.githubusercontent.com/swaywm/wlr-protocols/b010a03648b88d143236de193bddbfea0c08bc84/unstable/wlr-virtual-pointer-unstable-v1.xml -o "$runtime/virtual-pointer.xml"
curl -fsSL https://raw.githubusercontent.com/atx/wtype/v0.4/protocol/virtual-keyboard-unstable-v1.xml -o "$runtime/virtual-keyboard.xml"
(cd "$runtime" && sha256sum -c <<'CHECKSUMS'
3ff6d540be0bc5228195bf072bde42117ea17945a5c2061add5d3cf97d6bb524  virtual-pointer.xml
7ad7870003ecd592cae47dc19d277a609b7f18fd7b7be012623cf3225a7294f5  virtual-keyboard.xml
CHECKSUMS
)
for protocol in virtual-pointer virtual-keyboard; do
  wayland-scanner client-header "$runtime/$protocol.xml" "$runtime/$protocol.h"
  wayland-scanner private-code "$runtime/$protocol.xml" "$runtime/$protocol.c"
done
cc -Wall -Wextra -Werror experiments/fedora-display/pointer.c "$runtime/virtual-pointer.c" "$runtime/virtual-keyboard.c" -I "$runtime" -o "$runtime/pointer" $(pkg-config --cflags --libs wayland-client xkbcommon)
# The three packages above are unpacked, not installed, so everything they link against has to be
# on the machine already. Measured 13 September 2026 in a clean Fedora 44 container: the build
# succeeded and sway could not load libevdev.so.2, because the workstation this was written on had
# every library and the container had none. Say which are missing and how to get them, rather than
# leaving the first session to fail on a library name.
missing=$(LD_LIBRARY_PATH="$runtime/root/usr/lib64" ldd "$runtime/root/usr/bin/sway" "$runtime/pointer" 2>/dev/null | awk '/not found/ {print $1}' | sort -u)
if [ -n "$missing" ]; then
  echo "The private compositor is built, and these libraries are not on this machine:" >&2
  echo "$missing" | sed 's/^/  /' >&2
  echo "Install the runtime packages, which needs a package manager:" >&2
  echo "  sudo dnf install cairo gdk-pixbuf2 glib2 json-c lcms2 libdisplay-info libdrm libevdev libglvnd-egl libglvnd-gles libinput libseat libwayland-client libwayland-cursor libwayland-server libxcb libxkbcommon mesa-libgbm pango pcre2 pixman systemd-libs vulkan-loader xcb-util-errors xcb-util-renderutil xcb-util-wm" >&2
  exit 1
fi
LD_LIBRARY_PATH="$runtime/root/usr/lib64" "$runtime/root/usr/bin/sway" --version
