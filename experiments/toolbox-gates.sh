#!/usr/bin/env bash
#
# G6 and G7 from docs/porting.md, on a Toolbx container of this host: the container variant for
# atomic hosts, where the compositor would run inside a rootless container and the applications stay
# outside. Two questions. G6: does a compositor started inside publish a Wayland socket the host can
# connect to, and who owns the X11 display number it allocates. G7: does `systemd-run --user --scope`
# from inside register on the host's user manager, in the slice asked for, with the budget files
# readable from inside.
#
# The container is a toolbox (`toolbox create orbit-gates`) with the runtime packages the bundled
# compositor links against installed inside it. Toolbx shares the host's network, PID and IPC
# namespaces, /tmp, /run/user/UID, /dev and the home directory, which is what makes every answer here
# a fact about that sharing rather than about containers in general; a plain podman container with
# its own /tmp is the case docs/porting.md refuses X11 for, and it is not this one.
#
# Binds no ports, publishes nothing, writes to output/toolbox-gates/ and a temporary directory.
# Usage: experiments/toolbox-gates.sh [container]   (default orbit-gates)
set -uo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/.." && pwd)
container=${1:-orbit-gates}
data=${XDG_DATA_HOME:-$HOME/.local/share}
runtime=$(ls -d "$data"/sbar-orbit/runtime/sway-*/ 2>/dev/null | head -1)
[ -n "$runtime" ] || { echo "No built native runtime; run ./install.sh --native first" >&2; exit 1; }
runtime=${runtime%/}
stamp=$(date +%Y%m%d-%H%M%S)
out=$root/output/toolbox-gates; mkdir -p "$out"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
log=$out/run-$stamp.log
py=/usr/bin/python3

{
  echo "run: $stamp container: $container"
  echo "container: $(podman inspect --format 'pid namespace {{.HostConfig.PidMode}}, network {{.HostConfig.NetworkMode}}, ipc {{.HostConfig.IpcMode}}, userns {{.HostConfig.UsernsMode}}' "$container")"
  echo "host X11 sockets before: $(ls /tmp/.X11-unix | tr '\n' ' ')"
  echo "host display: DISPLAY=${DISPLAY:-unset}"

  echo
  echo "=== G6: a compositor inside, probed from the host"
  toolbox run --container "$container" $py "$root/experiments/linux-families/smoke.py" \
    --sway "$runtime/root/usr/bin/sway" --libdir "$runtime/root/usr/lib64" --pointer "$runtime/pointer" \
    --x11 xterm --wayland foot --hold 40 --label toolbox > "$work/inside.jsonl" 2>"$work/inside.err" &
  inside=$!
  held=""
  for _ in $(seq 1 400); do
    held=$(grep -m1 '"holding"' "$work/inside.jsonl" 2>/dev/null); [ -n "$held" ] && break; $py -c 'import time; time.sleep(0.1)'
  done
  if [ -z "$held" ]; then echo "the compositor inside never reached its hold:"; cat "$work/inside.err" | tail -5; tail -c 600 "$work/inside.jsonl"; wait $inside; exit 1; fi
  wayland=$($py -c 'import json,sys; print(json.loads(sys.argv[1])["holding"]["wayland"])' "$held")
  display=$($py -c 'import json,sys; print(json.loads(sys.argv[1])["holding"]["display"] or "")' "$held")
  cpid=$($py -c 'import json,sys; print(json.loads(sys.argv[1])["compositorPid"])' "$held")
  echo "inside: wayland socket $wayland, X11 display ${display:-none}, compositor pid $cpid"
  echo "host sees the socket: $([ -S "$wayland" ] && echo yes || echo no)"
  echo "host view of the compositor's cgroup: $(cat /proc/$cpid/cgroup 2>/dev/null || echo 'not visible')"
  # The pointer helper is a plain Wayland client that binds both virtual input globals and says
  # "ready"; run from the host against the container's socket, it is the socket visibility probe.
  answer=$($py - "$runtime/pointer" "$wayland" <<'PY'
import subprocess, sys, time
p = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
line = b""; deadline = time.time() + 5
while time.time() < deadline and not line.endswith(b"\n") and p.poll() is None:
    chunk = p.stdout.read1(64); line += chunk
    if not chunk: break
print(line.decode().strip() or f"no answer, exit {p.poll()}, {p.stderr.read1(200).decode().strip()}")
p.terminate()
PY
)
  echo "host pointer helper against the container's compositor: $answer"
  echo "host X11 sockets during: $(ls /tmp/.X11-unix | tr '\n' ' ')"
  if [ -n "$display" ]; then
    n=${display#:}
    echo "host connect to the filesystem socket /tmp/.X11-unix/X$n: $($py -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(2)
try: s.connect('/tmp/.X11-unix/X$n'); print('connected')
except OSError as e: print('refused:', e)")"
    echo "host connect to the abstract socket @/tmp/.X11-unix/X$n: $($py -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(2)
try: s.connect('\0/tmp/.X11-unix/X$n'); print('connected')
except OSError as e: print('refused:', e)")"
    echo "host's own display number: ${DISPLAY:-unset}; the container's: $display; same integer: $([ "${DISPLAY:-}" = "$display" ] && echo YES, a collision || echo no)"
    echo "X$n lock on the shared /tmp: $(ls -la /tmp/.X$n-lock 2>/dev/null | awk '{print $3, $NF}' || echo none)"
  fi
  wait $inside
  final=$(tail -n1 "$work/inside.jsonl")
  echo "inside report: $($py -c 'import json,sys; r=json.loads(sys.argv[1]); print(json.dumps({"ok": r["ok"], "steps": {k: v["ok"] for k, v in r["steps"].items()}, "timingsMs": r["timingsMs"], "windows": [(w.get("app_id") or w.get("class"), w["shell"]) for w in r["steps"].get("fixtures", {}).get("windows", [])]}))' "$final")"
  echo "host X11 sockets after: $(ls /tmp/.X11-unix | tr '\n' ' ')"
  cp "$work/inside.jsonl" "$out/g6-inside-$stamp.jsonl"

  echo
  echo "=== G7: systemd-run --user --scope from inside"
  unit=orbit-g7-$stamp
  toolbox run --container "$container" systemd-run --user --scope --slice=sbarorbit.slice --unit="$unit" -- sleep 15 > "$work/g7.out" 2>&1 &
  runner=$!
  spid=""
  for _ in $(seq 1 100); do spid=$(pgrep -n -x sleep); [ -n "$spid" ] && grep -q sbarorbit /proc/$spid/cgroup 2>/dev/null && break; spid=""; $py -c 'import time; time.sleep(0.1)'; done
  echo "host user manager: $(systemctl --user show "$unit.scope" -p ActiveState -p ControlGroup -p Slice 2>&1 | tr '\n' ' ')"
  if [ -n "$spid" ]; then
    echo "the process, from the host: pid $spid cgroup $(cat /proc/$spid/cgroup)"
    echo "the same process, from inside: $(toolbox run --container "$container" cat /proc/$spid/cgroup 2>&1)"
    path=$(cut -d: -f3 /proc/$spid/cgroup)
    echo "budget files from inside, through /sys/fs/cgroup$path:"
    toolbox run --container "$container" sh -c "head -1 /sys/fs/cgroup$path/cpu.stat; cat /sys/fs/cgroup$path/../cpu.max 2>/dev/null | sed 's/^/parent cpu.max: /'; cat /sys/fs/cgroup$path/../../cpu.max 2>/dev/null | sed 's/^/slice cpu.max: /'" 2>&1
    echo "the container's own cgroup, for contrast: $(toolbox run --container "$container" cat /proc/self/cgroup 2>&1)"
  else
    echo "no sleep process landed in sbarorbit.slice; systemd-run said: $(cat "$work/g7.out")"
  fi
  wait $runner
  echo "systemd-run exit: $? output: $(cat "$work/g7.out" | tr '\n' ' ')"
} 2>&1 | tee "$log"
echo; echo "log: $log"
