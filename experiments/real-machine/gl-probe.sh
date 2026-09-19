#!/usr/bin/env bash
#
# The 3D question the first run left open, and which the kitty row could not answer.
#
# kitty is a terminal that happens to composite glyphs through GL. An empty kitty window proves a
# GL-using client can start, map and be captured; it does not prove a 3D application renders. This
# launches glxgears, an actual animated 3D scene, inside the private display, captures two frames a
# few seconds apart, and reads what the compositor and the GL stack say they bound. Two outcomes are
# deliberately kept apart: an application that REFUSES for want of hardware GL, and one that starts
# and renders through llvmpipe. Only the second is a pass, and it is Limited on software rendering.
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export ORBIT_SOCKET=$XDG_RUNTIME_DIR/sbar-orbit/broker.sock
export ORBIT_CAPTURE_TIMEOUT_MS=${ORBIT_CAPTURE_TIMEOUT_MS:-30000}
evidence=$HOME/evidence
mkdir -p "$evidence"
cd "$HOME/src" || exit 1

pause() { /usr/bin/python3 -c "import time; time.sleep($1)"; }

echo "=== what the GL stack on this guest says it is"
echo "--- glxinfo -B"
glxinfo -B 2>&1 | head -12
echo "--- glxinfo renderer string"
glxinfo 2>&1 | grep -iE "^OpenGL renderer|^OpenGL vendor|^OpenGL version" | head -3

capture() {
  local session=$1 label=$2
  ./bin/sbar-orbit session observe "$session" > "$evidence/$label.json" 2>&1 || return 1
  ORBIT_FRAME_OUT="$evidence/$label.jpg" /usr/bin/python3 - "$evidence/$label.json" <<'PY'
import base64, json, os, sys
frame = json.load(open(sys.argv[1]))["result"]
image = base64.b64decode(frame["image"])
open(os.environ["ORBIT_FRAME_OUT"], "wb").write(image)
presence = frame.get("presence") or {}
print("frame:", frame["width"], "x", frame["height"], len(image), "bytes; windows:",
      [t.get("label") for t in (presence.get("tabs") or [])])
PY
}

session=$(./bin/sbar-orbit session create fedora | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sessionId"])')
echo; echo "session: $session"

launch() {
  printf '%s' "$1" > "$HOME/gl-action.json"
  ./bin/sbar-orbit act "$session" "@$HOME/gl-action.json"
}

echo; echo "=== glxgears, an actual animated 3D scene, under Xwayland"
launch '{"type":"launch","argv":["/usr/bin/glxgears"],"toolkit":"x11"}'
echo "--- launch exit: $?"
pause 8
capture "$session" gl-gears-first
pause 4
capture "$session" gl-gears-second

echo; echo "=== are the two glxgears frames different, which is what animation means"
if [ -s "$evidence/gl-gears-first.jpg" ] && [ -s "$evidence/gl-gears-second.jpg" ]; then
  a=$(md5sum "$evidence/gl-gears-first.jpg" | cut -d' ' -f1)
  b=$(md5sum "$evidence/gl-gears-second.jpg" | cut -d' ' -f1)
  echo "first:  $a  $(stat -c %s "$evidence/gl-gears-first.jpg") bytes"
  echo "second: $b  $(stat -c %s "$evidence/gl-gears-second.jpg") bytes"
  [ "$a" != "$b" ] && echo "the scene moved between the two captures" || echo "the two frames are identical: nothing animated"
fi

echo; echo "=== glmark2, which prints the renderer it bound and refuses loudly when it cannot"
timeout 60 glmark2-wayland --off-screen -b build 2>&1 | head -20 || echo "glmark2 off-screen exit: $?"

echo; echo "=== the compositor's own log for this session"
find "$XDG_RUNTIME_DIR" -name compositor.log -newermt '-10 minutes' 2>/dev/null | while read -r l; do
  echo "--- $l"
  grep -iE "renderer|GLES|EGL|DRM|pixman|llvmpipe|virgl" "$l" | sort -u | head -15
done

./bin/sbar-orbit session stop "$session" > /dev/null
echo; echo "done"
