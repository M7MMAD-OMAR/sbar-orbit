#!/usr/bin/env bash
#
# The gate 3 run itself, inside the Fedora 44 guest, as the unprivileged lingering account.
#
# Every step is expected to pass here: this machine has systemd as PID 1, a real logind seat, a user
# manager with delegated cgroup controllers, and a DRM device from virtio-gpu. A non-zero exit is a
# finding, not something to excuse. The one honest limit is that the GPU is virtual and rendering is
# software, so nothing here is claimed above `Limited`.
#
# Source comes from a `git archive` of tracked source only; there is no node_modules and no output
# directory in it, because the point is that tracked source is enough.
#
# ORBIT_CAPTURE_TIMEOUT_MS is raised to 30000 for the whole run, on purpose and recorded here: this
# machine paints through llvmpipe with no hardware GL behind it, so the shipped 3000 ms default would
# read a slow software rasteriser as a broken capture path. Raising the budget measures the capture
# path; it does not excuse a failure, and every capture still has to return real content.
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export ORBIT_SOCKET=$XDG_RUNTIME_DIR/sbar-orbit/broker.sock
export ORBIT_CAPTURE_TIMEOUT_MS=${ORBIT_CAPTURE_TIMEOUT_MS:-30000}
archive=${ORBIT_SOURCE_ARCHIVE:-$HOME/source.tar}
evidence=$HOME/evidence
results=()

rm -rf "$evidence"; mkdir -p "$evidence"

step() {
  local name=$1; shift
  echo; echo "=== step: ${name}"; echo "--- command: $*"
  "$@"; local code=$?
  echo "--- exit ${name}: ${code}"
  results+=("${name} ${code}")
  return 0
}

pause() { /usr/bin/python3 -c "import time; time.sleep($1)"; }

# A shell over ssh eats quoting twice, so every action goes through a file, which is the form the CLI
# grew for exactly this reason.
act() {
  local session=$1 document=$2
  printf '%s' "$document" > "$HOME/action.json"
  ./bin/sbar-orbit act "$session" "@$HOME/action.json"
}

echo "=== machine"
cat /etc/fedora-release
echo "kernel: $(uname -srm)"
echo "virtualization: $(systemd-detect-virt)"
echo "account: $(id -un) uid $(id -u)"
echo "pid 1: $(ps -p 1 -o comm=)"
echo "linger: $(loginctl show-user "$(id -un)" -p Linger --value)"
echo "seats: $(loginctl list-seats --no-legend | tr '\n' ' ')"
echo "sessions: $(loginctl list-sessions --no-legend | tr '\n' ' ')"
echo "user manager: $(systemctl --user is-system-running 2>&1)"
echo "drm: $(ls /dev/dri 2>&1 | tr '\n' ' ')"
echo "drm driver: $(basename "$(readlink -f /sys/class/drm/card0/device/driver 2>/dev/null)" 2>/dev/null)"
echo "capture budget: ${ORBIT_CAPTURE_TIMEOUT_MS} ms (raised from the 3000 ms default; software rendering)"

echo; echo "=== what draws here, so an OpenGL row can say which it was"
echo "--- glxinfo renderer"
glxinfo -B 2>&1 | grep -iE "vendor|renderer|version|device" | head -8 || echo "glxinfo: not installed"
echo "--- eglinfo"
eglinfo 2>&1 | grep -iE "renderer|vendor" | head -6 || echo "eglinfo: not installed"

echo; echo "=== what the guest reports as its own size, and what Orbit sizes the budget from"
echo "guest nproc: $(nproc)"
echo "guest /proc/cpuinfo processors: $(grep -c ^processor /proc/cpuinfo)"
echo "guest MemTotal: $(awk '/MemTotal/{print $2}' /proc/meminfo) kB"
echo "the host this guest runs on has 24 processors and about 32 GiB; if Orbit's budget below is"
echo "sized from 4 and 6 GiB, the container defect in roadmap gate 3 does not reproduce on a VM."

echo; echo "=== delegated cgroup controllers"
uid=$(id -u)
manager=/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service
echo "user manager cgroup: $manager"
echo "cgroup.controllers: $(cat "$manager/cgroup.controllers" 2>&1)"
echo "cgroup.subtree_control: $(cat "$manager/cgroup.subtree_control" 2>&1)"

cd "$HOME" || exit 1
rm -rf src && mkdir -p src
step extract tar -xf "$archive" -C src
cd src || exit 1

step bun-install bun install --frozen-lockfile
step preflight ./bin/sbar-orbit preflight
step install-dry-run ./install.sh --dry-run --json
step install ./install.sh --json
step install-native ./install.sh --native

step broker-active systemctl --user is-active sbar-orbit.service
pause 5
step broker-still-active systemctl --user is-active sbar-orbit.service
step broker-unit systemctl --user show sbar-orbit.service -p ActiveState -p SubState -p NRestarts -p ExecMainStartTimestamp
step doctor ./bin/sbar-orbit doctor
step doctor-report ./bin/sbar-orbit doctor --report

echo; echo "=== the slice, which only a real user manager can create"
slice=$manager/sbarorbit.slice
step slice-exists test -d "$slice"
echo "slice cgroup.controllers: $(cat "$slice/cgroup.controllers" 2>&1)"
echo "slice cpu.stat:"; cat "$slice/cpu.stat" 2>&1
step budget systemctl --user show sbarorbit.slice -p CPUQuotaPerSecUSec -p MemoryMax -p TasksMax

before=$(awk '/usage_usec/{print $2}' "$slice/cpu.stat" 2>/dev/null || echo 0)

# A capture is judged on its content, not on its exit code. The python program goes in a single
# quoted heredoc so no shell touches its quotes: the earlier `bash -c` wrapper ate them and surfaced
# a truncated document as a JSONDecodeError, which is the same class of defect main fixed in 5576f11
# for the `act` argument. A step fails here only when the frame is absent or under the size floor.
capture() {
  local session=$1 label=$2 out="$evidence/$2.jpg"
  rm -f "$out"
  if ! ./bin/sbar-orbit session observe "$session" > "$evidence/$label.json" 2>"$evidence/$label.err"; then
    echo "observe refused: $(head -c 300 "$evidence/$label.err")"
    return 1
  fi
  ORBIT_FRAME_OUT="$out" /usr/bin/python3 - "$evidence/$label.json" <<'PY'
import base64, json, os, sys
document = json.load(open(sys.argv[1]))
frame = document["result"]
image = base64.b64decode(frame["image"])
path = os.environ["ORBIT_FRAME_OUT"]
open(path, "wb").write(image)
presence = frame.get("presence") or {}
print("frame:", frame["mimeType"], frame["width"], "x", frame["height"], len(image),
      "bytes; title:", repr(presence.get("title")), "windows:", len(presence.get("tabs") or []))
# A blank 6758 byte JPEG once passed a byte count on this project's Windows guest while the
# navigation had silently never happened. A floor is the cheapest guard against that.
if len(image) < 8000:
    print("REFUSED: frame is under the 8000 byte floor, which is what a blank surface looks like")
    sys.exit(1)
if not image.startswith(b"\xff\xd8\xff"):
    print("REFUSED: not a JPEG")
    sys.exit(1)
PY
}

# ---------------------------------------------------------------- browser half
echo; echo "=== browser session, through the installed command"
browser=$(./bin/sbar-orbit session create browser 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sessionId"])' 2>/dev/null)
echo "browser session: ${browser:-none}"
if [ -n "$browser" ]; then
  step browser-navigate act "$browser" '{"type":"navigate","url":"https://example.com/"}'
  step browser-read act "$browser" '{"type":"read","selector":"h1"}'
  step browser-observe capture "$browser" browser
  step browser-stop ./bin/sbar-orbit session stop "$browser"
else
  results+=("browser-session 1")
fi

# ---------------------------------------------------------------- native half
echo; echo "=== native session, the half nobody has run on a machine with a screen"
native=$(./bin/sbar-orbit session create fedora 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sessionId"])' 2>/dev/null)
echo "native session: ${native:-none}"
if [ -n "$native" ]; then
  wayland_app=/usr/bin/gnome-text-editor
  [ -x "$wayland_app" ] || wayland_app=/usr/bin/gnome-calculator
  echo "wayland application: $wayland_app"
  step native-launch-wayland act "$native" "{\"type\":\"launch\",\"argv\":[\"$wayland_app\"],\"toolkit\":\"wayland\"}"
  pause 6
  step native-frame-wayland-before capture "$native" native-wayland-before
  step native-type-wayland act "$native" '{"type":"text","text":"orbit wayland on a real machine"}'
  pause 3
  step native-frame-wayland capture "$native" native-wayland-typed
  step native-click act "$native" '{"type":"pointer","x":640,"y":400}'
  pause 2
  step native-frame-click capture "$native" native-click
  step native-close-wayland act "$native" '{"type":"window","command":"close"}'
  pause 3

  step native-launch-x11 act "$native" '{"type":"launch","argv":["/usr/bin/xterm"],"toolkit":"x11"}'
  pause 6
  step native-frame-x11-before capture "$native" native-x11-before
  step native-type-x11 act "$native" '{"type":"text","text":"orbit xwayland on a real machine"}'
  pause 3
  step native-frame-x11 capture "$native" native-x11-typed

  # The single most interesting thing this run can measure: an OpenGL application on virtio-gpu,
  # which no container run could attempt. Two outcomes look identical in a bare log, so they are
  # separated here: an application that REFUSES for want of hardware GL, and one that starts and
  # renders through llvmpipe. The compositor log and glxinfo below say which it was.
  if [ -x /usr/bin/kitty ]; then
    step native-launch-opengl act "$native" '{"type":"launch","argv":["/usr/bin/kitty"],"toolkit":"wayland"}'
    pause 10
    step native-frame-opengl capture "$native" native-opengl
    step native-presence-opengl ./bin/sbar-orbit session observe "$native" --metadata
  fi
  step native-stop ./bin/sbar-orbit session stop "$native"
else
  results+=("native-session 1")
fi

after=$(awk '/usage_usec/{print $2}' "$slice/cpu.stat" 2>/dev/null || echo 0)
echo; echo "=== cost inside the budget above"
echo "orbit cpu for the session steps: $(( (after - before) / 1000 )) ms"
echo "slice at the end: $(cat "$slice/pids.current" 2>/dev/null) tasks, $(( $(cat "$slice/memory.current" 2>/dev/null || echo 0) / 1048576 ))M"
echo "refused forks: $(awk '{print $2}' "$slice/pids.events" 2>/dev/null | tr '\n' ' ')"

echo; echo "=== the compositor's own renderer line, from its log"
# src/fedora.ts writes compositor.log into each session's private runtime directory.
find "$XDG_RUNTIME_DIR" -name compositor.log 2>/dev/null | while read -r l; do
  echo "--- $l"
  grep -iE "GLES2|GL renderer|pixman|Creating .* renderer|llvmpipe|virgl|EGL|DRM device" "$l" | sort -u | head -12
done
echo "--- glxinfo, on the guest itself"
glxinfo -B 2>&1 | grep -iE "vendor|renderer|OpenGL version|device" | head -8

echo; echo "=== unit drift, which doctor learned to report in f46ad69 (a fresh install should be current)"
./bin/sbar-orbit doctor 2>&1 | /usr/bin/python3 -c 'import json,sys
d=json.load(sys.stdin)["result"]
print("units:", json.dumps({k:v for k,v in d.items() if "drift" in k.lower() or "unit" in k.lower()}) or "no drift field")' 2>&1 | head -5

echo; echo "=== frame content check, because a frame that returns is not proof"
for f in "$evidence"/*.jpg; do
  [ -e "$f" ] || continue
  echo "$(basename "$f"): $(stat -c %s "$f") bytes, $(md5sum "$f" | cut -c1-12)"
done
echo "byte identical frames (a duplicate here means two steps captured one state):"
md5sum "$evidence"/*.jpg 2>/dev/null | awk '{print $1}' | sort | uniq -d

echo; echo "=== results"
printf '%s\n' "${results[@]}"
printf '%s\n' "${results[@]}" | awk '$2 != 0 {bad++} END {exit bad ? 1 : 0}'
