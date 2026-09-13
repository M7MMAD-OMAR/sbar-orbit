#!/usr/bin/env bash
# Runs inside the systemd container as the unprivileged "orbit" account, which has a user manager of
# its own. Unlike inside.sh, every step here is expected to pass: this machine has the systemd user
# session and the delegated cgroup controllers that the other one cannot have, so there is nothing to
# excuse. A non-zero exit is a finding.
set -uo pipefail
export XDG_RUNTIME_DIR=/run/user/1000
export ORBIT_SOCKET=$XDG_RUNTIME_DIR/sbar-orbit/broker.sock
source_archive=${ORBIT_SOURCE_ARCHIVE:-/mnt/source.tar}
results=()

step() {
  local name=$1; shift
  echo; echo "=== step: ${name}"; echo "--- command: $*"
  "$@"; local code=$?
  echo "--- exit ${name}: ${code}"
  results+=("${name} ${code}")
  return 0
}

echo "=== machine"
cat /etc/fedora-release
echo "kernel: $(uname -srm)"
echo "account: $(id -un) uid $(id -u)"
echo "bun: $(bun --version)"
echo "user manager: $(systemctl --user is-system-running)"
echo "own cgroup: $(cut -d: -f3 /proc/self/cgroup | head -1)"
echo "delegated controllers: $(cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -1)/cgroup.controllers" 2>/dev/null)"

cd "$HOME" || exit 1
mkdir -p src
step extract tar -xf "$source_archive" -C src
cd src || exit 1
step bun-install bun install --frozen-lockfile --ignore-scripts
step preflight ./bin/sbar-orbit preflight
# The private compositor and the pointer helper, which a source release does not carry.
step native-bootstrap bash experiments/fedora-display/bootstrap.sh
step install-dry-run ./install.sh --dry-run --json
step install ./install.sh --json
step broker-active systemctl --user is-active sbar-orbit.service
step budget systemctl --user show sbarorbit.slice -p CPUQuotaPerSecUSec -p MemoryMax -p TasksMax
step doctor ./bin/sbar-orbit doctor

# What the whole gate is about: a session on a machine that has never seen this project.
slice=/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/sbarorbit.slice
before=$(awk '/usage_usec/{print $2}' "$slice/cpu.stat" 2>/dev/null || echo 0)
step browser-session ./bin/sbar-orbit session create browser
native=$(./bin/sbar-orbit session create fedora 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sessionId"])' 2>/dev/null)
echo; echo "=== step: native-session"; echo "--- session: ${native:-none}"
if [ -n "$native" ]; then
  step native-launch ./bin/sbar-orbit act "$native" '{"type":"launch","argv":["/usr/bin/xterm"],"toolkit":"x11"}'
  sleep 4
  step native-type ./bin/sbar-orbit act "$native" '{"type":"text","text":"orbit on a fresh machine"}'
  sleep 2
  step native-observe env SESSION="$native" bash -c './bin/sbar-orbit session observe "$SESSION" | python3 -c "
import base64, json, sys
frame = json.load(sys.stdin)[\"result\"]
image = base64.b64decode(frame[\"image\"])
open(\"/tmp/frame.jpg\", \"wb\").write(image)
print(\"frame:\", frame[\"mimeType\"], frame[\"width\"], \"x\", frame[\"height\"], len(image), \"bytes; windows:\",
      len(frame[\"presence\"].get(\"tabs\") or []))
"'
  step native-stop ./bin/sbar-orbit session stop "$native"
else
  results+=("native-session 1")
fi
after=$(awk '/usage_usec/{print $2}' "$slice/cpu.stat" 2>/dev/null || echo 0)

echo; echo "=== cost, inside the budget printed above"
echo "orbit cpu for the session steps: $(( (after - before) / 1000 )) ms"
echo "slice at the end: $(cat "$slice/pids.current" 2>/dev/null) tasks, $(( $(cat "$slice/memory.current" 2>/dev/null || echo 0) / 1048576 ))M"
echo "refused forks on the slice: $(awk '{print $2}' "$slice/pids.events" 2>/dev/null)"

echo; echo "=== results"
printf '%s\n' "${results[@]}"
printf '%s\n' "${results[@]}" | awk '$2 != 0 {bad++} END {exit bad ? 1 : 0}'
