#!/usr/bin/python3
"""Read-only live viewer of the private lab and two hidden native targets.

Only guarded lab displays are captured. Bind an unused loopback port and keep
the viewer alive in the lab scope so lab.py down also stops observation.
"""
import json
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from lab import guard, lab_env, lab_path

lab = lab_path(sys.argv[1])
env = lab_env(lab)
guard(env)
pids = [int(value) for value in sys.argv[2:4]]
assert len(pids) == 2
token = secrets.token_urlsafe(24)
cache = {}
capture_lock = threading.Lock()

HTML = """<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orbit: live cursor lab</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#101827;color:#e9edf4;font:15px system-ui,sans-serif}
header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid #303b4d}
h1{font-size:18px;margin:0}#status{font-size:13px;color:#a2d9ce}
main{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:16px;padding:20px}
section{min-width:0}h2{font-size:13px;font-weight:500;margin:0 0 10px;color:#c6ceda}
img{width:100%;display:block;object-fit:contain;background:#080e18;border:1px solid #303b4d;border-radius:8px}
.targets{display:grid;gap:20px;align-content:start}p{margin:14px 0 0;color:#acb8c9;font-size:13px}
@media(max-width:900px){main{grid-template-columns:1fr;padding:12px}.targets{grid-template-columns:1fr 1fr}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style>
<header><h1>Orbit cursor lab</h1><span id="status" role="status">Connecting</span></header>
<main><section><h2>Shared lab display</h2><img id="screen" alt="Private lab display with actual agent cursors">
<p>The smaller views show the real application windows running in the background.</p></section>
<div class="targets"><section><h2>Agent Alpha</h2><img id="alpha" alt="Alpha agent's native application"></section>
<section><h2>Agent Beta</h2><img id="beta" alt="Beta agent's native application"></section></div></main>
<script>
const images=['screen','alpha','beta'];let stopped=false;
async function frame(id){
 const response=await fetch(`${id}.png?t=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Frame unavailable');
 const url=URL.createObjectURL(await response.blob()),img=document.getElementById(id),previous=img.dataset.url;
 await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});
 img.dataset.url=url;if(previous)URL.revokeObjectURL(previous);
}
async function poll(){
 if(stopped)return;
 try{await Promise.all(images.map(frame));document.getElementById('status').textContent='Live';}
 catch(error){document.getElementById('status').textContent='Waiting for the lab';}
 setTimeout(poll,1000);
}
document.addEventListener('visibilitychange',()=>{stopped=document.hidden;if(!stopped)poll();});
poll();
</script></html>"""


def capture(name):
    with capture_lock:
        existing = cache.get(name)
        if existing and time.monotonic() - existing[0] < 0.8:
            return existing[1]
        command = ["grim"]
        if name != "screen":
            clients = json.loads(subprocess.check_output(["hyprctl", "clients", "-j"], env=env, timeout=5))
            pid = pids[0 if name == "alpha" else 1]
            window = next(c for c in clients if c["pid"] == pid)
            command += ["-T", window["stableId"]]
        data = subprocess.check_output([*command, "-"], env=env, timeout=10, stderr=subprocess.PIPE)
        cache[name] = (time.monotonic(), data)
        return data


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        prefix = f"/{token}/"
        if not path.startswith(prefix):
            self.send_error(404)
            return
        name = path[len(prefix):]
        if name == "":
            data, content_type = HTML.encode(), "text/html; charset=utf-8"
        elif name in ["screen.png", "alpha.png", "beta.png"]:
            try:
                data, content_type = capture(name[:-4]), "image/png"
            except (subprocess.SubprocessError, StopIteration, ValueError):
                self.send_error(503, "Lab frame unavailable")
                return
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
url = f"http://127.0.0.1:{server.server_port}/{token}/"
(lab / "watch-url").write_text(url + "\n")
print(url, flush=True)
server.serve_forever()
