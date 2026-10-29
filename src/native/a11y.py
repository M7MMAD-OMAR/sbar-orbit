"""Compact text observation from the platform accessibility tree, run beside the image capture path."""
import json
from pathlib import Path
import subprocess

DUMP = Path(__file__).with_name("a11y_dump.py")
FORMATS = ("image", "text", "both")
MAX_NODES = 300
MAX_BYTES = 16000
DEADLINE_MS = 1500


def window_identity(clients, address, stable):
    """Process and compositor title of one leased window, from the compositor client list."""
    for client in clients:
        if isinstance(client, dict) and client.get("address") == address and client.get("stableId") == stable:
            pid, title = client.get("pid"), client.get("title")
            if type(pid) is int and pid > 0 and isinstance(title, str):
                return pid, title
    return None


def _trim(nodes):
    """Drop whole trailing nodes until the serialized tree fits, so the cut never splits a node."""
    size, kept = 2, []
    for node in nodes:
        size += len(json.dumps(node, ensure_ascii=False, separators=(",", ":"))) + 1
        if size > MAX_BYTES:
            return kept, True
        kept.append(node)
    return kept, False


def read_tree(pid, title, runtime):
    """A bounded tree for one window, or the reason none is available. Never raises on a missing tree."""
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": runtime}
    try:
        done = subprocess.run(["/usr/bin/python3", "-I", str(DUMP), str(pid), title, str(MAX_NODES), str(DEADLINE_MS)],
                              env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=5, check=False)
        reply = json.loads(done.stdout[:2_000_000]) if done.returncode == 0 else None
    except (subprocess.TimeoutExpired, ValueError, OSError):
        reply = None
    if not isinstance(reply, dict) or reply.get("status") not in ("ok", "unavailable"):
        return {"status": "unavailable", "reason": "accessibility query failed or timed out"}
    if reply["status"] != "ok":
        return {"status": "unavailable", "reason": str(reply.get("reason", "unavailable"))[:120]}
    nodes, cut = _trim(reply["nodes"] if isinstance(reply.get("nodes"), list) else [])
    truncated = reply.get("truncated") or ("bytes" if cut else None)
    return {"status": "ok", "toolkit": str(reply.get("toolkit", ""))[:24], "nodes": nodes,
            "truncated": truncated, "queryMs": reply.get("ms")}
