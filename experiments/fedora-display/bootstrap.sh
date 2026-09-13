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
LD_LIBRARY_PATH="$runtime/root/usr/lib64" "$runtime/root/usr/bin/sway" --version
