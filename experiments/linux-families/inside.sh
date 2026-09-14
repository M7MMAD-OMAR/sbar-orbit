#!/usr/bin/env bash
# Runs inside one Linux family container as the unprivileged "orbit" account, and answers four of
# the Linux gates in docs/porting.md against that family:
#   G2   does the bundled Fedora wlroots load and run here (dlopen, ldd -r, then the smoke probe)
#   G1   did that compositor start with no logind session at all (there is none in this container)
#   G5   does this family's own sway, unpacked into a private prefix, start from there at all
#   G29  do unprivileged user namespaces and socat give the confined egress shape Orbit uses
# Every step records its own result and the run continues; the report is one JSON at /tmp/report.json.
set -uo pipefail
runtime_archive=${ORBIT_RUNTIME_ARCHIVE:-/mnt/runtime.tar}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
report=/tmp/report.json
bundle=$HOME/runtime
distro=/opt/distro-sway
py=$(command -v python3)

echo "=== machine"
. /etc/os-release; echo "os: $PRETTY_NAME"
echo "kernel: $(uname -srm)"
echo "glibc: $($py -c 'import os;print(os.confstr("CS_GNU_LIBC_VERSION"))')"
echo "account: $(id -un) uid $(id -u)"
echo "pid 1: $(tr -d '\0' < /proc/1/cmdline)"
echo "logind: /run/systemd/system $([ -e /run/systemd/system ] && echo present || echo absent), seatd $([ -e /run/seatd.sock ] && echo present || echo absent), XDG_RUNTIME_DIR ${XDG_RUNTIME_DIR:-unset}"

mkdir -p "$bundle" && tar -xf "$runtime_archive" -C "$bundle"
sway=$bundle/root/usr/bin/sway; libdir=$bundle/root/usr/lib64; pointer=$bundle/pointer

echo
echo "=== G2: the bundled runtime on this libc"
export LD_LIBRARY_PATH=$libdir
missing=$(ldd -r "$sway" "$libdir/libwlroots-0.19.so" "$pointer" 2>&1 | awk '/not found/ {print $1} /undefined symbol/ {print $3}' | sort -u | tr '\n' ' ')
echo "ldd -r missing: ${missing:-none}"
dlopen=$($py - "$libdir" <<'PY'
import ctypes, json, os, sys
out = {}
for name in ["libwlroots-0.19.so", "libliftoff.so.0"]:
    try:
        ctypes.CDLL(f"{sys.argv[1]}/{name}", mode=os.RTLD_NOW); out[name] = "loaded"
    except OSError as error:
        out[name] = str(error)
print(json.dumps(out))
PY
)
echo "dlopen RTLD_NOW: $dlopen"
"$sway" --version 2>&1 | head -1
bundled=$($py "$here/smoke.py" --sway "$sway" --libdir "$libdir" --pointer "$pointer" --label bundled)
echo "smoke: $bundled"
unset LD_LIBRARY_PATH

echo
echo "=== G5: this family's own sway from a private prefix"
distro_report='{"ok":false,"detail":"no distro prefix in the image"}'
if [ -d "$distro" ]; then
  distro_sway=$(find "$distro" -type f -name sway -path '*bin/sway' | head -1)
  distro_lib=$(find "$distro" -name 'libwlroots*.so*' -printf '%h\n' | sort -u | head -1)
  echo "manifest: $(cat "$distro/manifest.txt" 2>/dev/null | tr '\n' ' ')"
  echo "sway: $distro_sway"; echo "libdir: $distro_lib"
  if [ -n "$distro_sway" ] && [ -n "$distro_lib" ]; then
    export LD_LIBRARY_PATH=$distro_lib
    distro_missing=$(ldd -r "$distro_sway" 2>&1 | awk '/not found/ {print $1} /undefined symbol/ {print $3}' | sort -u | tr '\n' ' ')
    echo "ldd -r missing: ${distro_missing:-none}"
    "$distro_sway" --version 2>&1 | head -1
    # The bundled pointer helper is the client here on purpose: the question is whether the
    # family's compositor advertises the same virtual input globals to the helper Orbit already has.
    distro_report=$($py "$here/smoke.py" --sway "$distro_sway" --libdir "$distro_lib" --pointer "$pointer" --label distro)
    echo "smoke: $distro_report"
    unset LD_LIBRARY_PATH
  fi
fi

echo
echo "=== G29: confined egress"
egress=$($py - <<'PY'
import json, os, shutil, socket, subprocess, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
out = {"bwrap": shutil.which("bwrap"), "socat": shutil.which("socat")}
probe = subprocess.run(["bwrap", "--unshare-net", "--dev-bind", "/", "/", "--die-with-parent", "/bin/true"], capture_output=True, text=True) if out["bwrap"] else None
out["probe"] = {"ok": probe is not None and probe.returncode == 0, "stderr": (probe.stderr.strip()[-300:] if probe else "bwrap absent")}
try:
    with open("/proc/sys/user/max_user_namespaces") as h: out["maxUserNamespaces"] = int(h.read())
except OSError: out["maxUserNamespaces"] = None
if not out["probe"]["ok"] or not out["socat"]:
    out["verdict"] = "in-browser"; print(json.dumps(out)); raise SystemExit
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"outside")
    def log_message(self, *a): pass
server = HTTPServer(("127.0.0.1", 0), Handler); port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
work = tempfile.mkdtemp(prefix="/tmp/orbit-egress-"); sock = os.path.join(work, "proxy.sock")
relay = subprocess.Popen(["socat", f"UNIX-LISTEN:{sock},fork,unlink-early", f"TCP:127.0.0.1:{port}"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(100):
    if os.path.exists(sock): break
    time.sleep(0.05)
inner = f"""
# Detached from the pipes, or the capture below waits on the listener rather than on the answer.
socat TCP-LISTEN:18080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:{sock} </dev/null >/dev/null 2>&1 &
listener=$!
sleep 0.3
python3 - <<'INNER'
import json, socket, urllib.request
r = {{}}
try: r["throughProxy"] = urllib.request.urlopen("http://127.0.0.1:18080/", timeout=5).read().decode()
except Exception as e: r["throughProxy"] = "error: " + str(e)[:120]
try: urllib.request.urlopen("http://127.0.0.1:{port}/", timeout=5).read(); r["directToHostLoopback"] = "reached"
except Exception as e: r["directToHostLoopback"] = "refused: " + str(e)[:80]
try:
    s = socket.create_connection(("1.1.1.1", 53), timeout=3); s.close(); r["directToInternet"] = "reached"
except Exception as e: r["directToInternet"] = "refused: " + str(e)[:80]
r["interfaces"] = open("/proc/net/dev").read().count(":") - 0
print(json.dumps(r))
INNER
kill $listener 2>/dev/null
"""
shapes = {"orbit": ["--unshare-net", "--unshare-pid", "--dev-bind", "/", "/", "--proc", "/proc"], "network-only": ["--unshare-net", "--dev-bind", "/", "/"]}
out["shapes"] = {}
for shape, flags in shapes.items():
    run = subprocess.run(["bwrap", *flags, "--die-with-parent", "/bin/sh", "-c", inner], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
    try: out["shapes"][shape] = json.loads(run.stdout.strip().splitlines()[-1])
    except Exception: out["shapes"][shape] = {"error": (run.stderr.strip() or run.stdout.strip())[-300:]}
    if "error" not in out["shapes"][shape]: break
relay.terminate(); server.shutdown()
out["shape"] = shape; out["inside"] = out["shapes"][shape]
inside = out.get("inside", {})
out["verdict"] = "confined" if inside.get("throughProxy") == "outside" and str(inside.get("directToHostLoopback", "")).startswith("refused") and str(inside.get("directToInternet", "")).startswith("refused") else "in-browser"
print(json.dumps(out))
PY
)
echo "egress: $egress"

$py - "${bundled:-{\}}" "${distro_report:-{\}}" "${egress:-{\}}" "$missing" "${dlopen:-{\}}" <<'PY'
import json, os, sys
bundled, distro, egress = (json.loads(v or "{}") for v in sys.argv[1:4])
release = dict(line.rstrip().split("=", 1) for line in open("/etc/os-release") if "=" in line)
report = {
  "family": release.get("ID", "").strip('"'), "os": release.get("PRETTY_NAME", "").strip('"'),
  "kernel": os.uname().release, "glibc": os.confstr("CS_GNU_LIBC_VERSION"),
  "logind": {"runSystemd": os.path.exists("/run/systemd/system"), "seatd": os.path.exists("/run/seatd.sock"), "pid1": open("/proc/1/cmdline", "rb").read().split(b"\0")[0].decode()},
  "G2": {"lddMissing": sys.argv[4].split(), "dlopen": json.loads(sys.argv[5] or "{}"), "smoke": bundled, "ok": bundled.get("ok", False) and not sys.argv[4].split()},
  # G1 asks whether a headless wlroots compositor starts with no logind session at all, which either
  # compositor answers: the bundled one where it loads, the family's own one where it does not.
  "G1": next(({"ok": True, "compositor": label, "contacts": smoke["steps"]["noLogindContact"]["contacts"]}
              for label, smoke in [("bundled", bundled), ("distro", distro)]
              if smoke.get("steps", {}).get("sockets", {}).get("ok") and smoke.get("steps", {}).get("noLogindContact", {}).get("ok")),
             {"ok": False, "compositor": None, "contacts": None}),
  "G5": {"smoke": distro, "ok": distro.get("ok", False)},
  "G29": {**egress, "ok": egress.get("verdict") == "confined"},
}
json.dump(report, open("/tmp/report.json", "w"), indent=2)
print("report: /tmp/report.json")
for gate in ["G2", "G1", "G5"]: print(f"{gate}: {'pass' if report[gate]['ok'] else 'FAIL'}")
print(f"G29: {egress.get('verdict')} ({egress.get('shape')})")
PY
for f in "$(echo "$bundled" | $py -c 'import json,sys;print(json.load(sys.stdin).get("frame") or "")')" "$(echo "$distro_report" | $py -c 'import json,sys;print(json.load(sys.stdin).get("frame") or "")')"; do
  [ -n "$f" ] && [ -f "$f" ] && cp "$f" "/tmp/frame-$(basename "$(dirname "$f")").png"
done
[ -f /tmp/orbit-native-*/compositor.log ] 2>/dev/null; cat /tmp/orbit-native-*/compositor.log 2>/dev/null | tail -20 > /tmp/compositor-tail.log
exit 0
