#!/usr/bin/env bash
#
# Provision the Fedora 44 guest built by vm.sh: everything a real desktop machine would already have,
# and nothing this project ships. Runs inside the guest as the unprivileged account.
#
# The package list is a deliverable in itself. Three groups:
#   base       what any machine needs to run Orbit at all
#   runtime    the 26 libraries the unpacked private compositor links against, found on 13 September
#              2026 when a clean build linked and then could not load libevdev.so.2
#   coverage   the fifteen applications experiments/application-coverage.ts launches
set -euo pipefail

base=(
  tar unzip procps-ng git curl cpio
  chromium python3 grim wl-clipboard xorg-x11-server-Xwayland
  gcc pkgconf-pkg-config wayland-devel libxkbcommon-devel wayland-utils
  xterm
  btrfs-progs           # without it every session.create threw; see roadmap gate 3
  mesa-dri-drivers mesa-libEGL mesa-libGL libglvnd-glx   # virtio-gpu needs a GL driver for gles2
)

# Unpacked, not installed: the compositor bundle's own dependencies have to be present already.
runtime=(
  cairo gdk-pixbuf2 glib2 json-c lcms2 libdisplay-info libdrm libevdev libglvnd-egl libglvnd-gles
  libinput libseat libwayland-client libwayland-cursor libwayland-server libxcb libxkbcommon
  mesa-libgbm pango pcre2 pixman systemd-libs vulkan-loader xcb-util-errors xcb-util-renderutil
  xcb-util-wm
)

coverage=(
  ptyxis gnome-characters gnome-clocks gnome-weather loupe papers showtime snapshot
  gnome-font-viewer inkscape libreoffice-writer konsole dolphin kitty gnome-calculator
)

echo "=== dnf install, base and runtime"
sudo dnf -y install --setopt=install_weak_deps=False "${base[@]}" "${runtime[@]}"

echo "=== dnf install, application coverage set"
sudo dnf -y install --setopt=install_weak_deps=False "${coverage[@]}" || {
  echo "some coverage packages were refused; each is recorded by name above" >&2
}

echo "=== bun"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
bun --version

# The website is a separate bun workspace. Without its own install, website/tests/locale.test.tsx
# fails with `Cannot find module 'react/jsx-dev-runtime'` and reads like a Fedora result when it is
# an uninstalled workspace. This project has hit that three times; both CI workflows carry the same
# step. It is here so the next person who builds this VM does not rediscover it.
if [ -d "$HOME/src/website" ]; then
  (cd "$HOME/src/website" && bun install --frozen-lockfile --ignore-scripts)
fi

echo "=== machine facts"
cat /etc/fedora-release
echo "kernel: $(uname -srm)"
echo "account: $(id -un) uid $(id -u)"
echo "pid 1: $(ps -p 1 -o comm=)"
echo "linger: $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
echo "seat: $(loginctl list-seats 2>/dev/null | head -2 | tr '\n' ' ')"
echo "user manager: $(systemctl --user is-system-running 2>&1)"
echo "own cgroup: $(cut -d: -f3 /proc/self/cgroup | head -1)"
echo "user manager controllers: $(cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers 2>/dev/null)"
echo "drm devices:"; ls -la /dev/dri/ 2>&1
echo "drm driver: $(cat /sys/class/drm/card0/device/uevent 2>/dev/null | tr '\n' ' ')"
echo "processors: $(nproc), memory: $(free -m | awk '/Mem:/{print $2}') MiB"
