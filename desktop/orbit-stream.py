#!/usr/bin/python3
"""One compact JSON line on standard output whenever what a bar would show changes.

This is the feed a shell module reads. `sbar-orbit status --watch` prints the same shape and can be
used instead; this exists because that one starts a Bun runtime, which measured 117 MB resident, and
a bar widget should not cost more than the desktop it decorates. This process measured 13 MB.

A line is printed at startup, then only when something changes, so a quiet desktop is a quiet pipe.
Timestamps are excluded from that comparison, or every second would be a change.

    orbit-stream.py [--interval SECONDS] [--no-presence]
    orbit-stream.py --open-viewer

`--open-viewer` is the other half a bar needs: it asks the broker for a viewer link and hands it to
the desktop's browser. The link carries a fresh access token, so it is requested at the moment of
the click and never written down, and only a loopback link is ever opened.

The shape, matching `sbar-orbit status`:

    {"socket": "...", "sampledAt": "...", "reachable": true, "running": 1, "paused": 0,
     "working": 0, "tabs": 0, "windows": 2, "summary": "1 session · 2 windows", "sessions": [...]}

and when the broker is not there:

    {"socket": "...", "reachable": false, "summary": "Orbit not running", "sessions": []}
"""
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from orbit_client import BrokerClient, broker_socket, counts, read_status, rpc, summarize  # noqa: E402


def snapshot(client, with_presence):
    sessions = read_status(client, with_presence)
    tally = counts(sessions)
    return {"socket": client.path, "reachable": True, **tally,
            "summary": summarize(sessions, tally),
            "sessions": [{"sessionId": s.get("sessionId"), "agentName": s.get("agentName"), "taskName": s.get("taskName"),
                          "state": s.get("state"), "backend": s.get("backend"),
                          "activity": s.get("activity"),
                          "title": (s.get("presence") or {}).get("title"),
                          "views": len((s.get("presence") or {}).get("tabs") or [])}
                         for s in sessions]}


def viewer_link_is_local(url):
    """The only link this will open: the broker's own loopback viewer with its token fragment."""
    return isinstance(url, str) and url.startswith("http://127.0.0.1:") and "#" in url and len(url.split("#", 1)[1]) >= 32


def open_viewer(path):
    try:
        url = rpc(path, "preview.open")["url"]
    except Exception as error:
        print(f"orbit-stream: could not open the viewer: {error}", file=sys.stderr)
        return 1
    if not viewer_link_is_local(url):
        print("orbit-stream: the broker returned something other than a local viewer link", file=sys.stderr)
        return 1
    subprocess.Popen(["xdg-open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0


def main():
    interval, with_presence = 1.0, True
    args = sys.argv[1:]
    while args:
        flag = args.pop(0)
        if flag == "--interval" and args:
            interval = max(0.2, float(args.pop(0)))
        elif flag == "--no-presence":
            with_presence = False
        elif flag == "--open-viewer":
            return open_viewer(broker_socket())
        elif flag in ("-h", "--help"):
            print(__doc__.strip())
            return 0
    path = broker_socket()
    client = BrokerClient(path)
    previous = None
    while True:
        try:
            line = snapshot(client, with_presence)
        except Exception:
            client.close()
            line = {"socket": path, "reachable": False, "running": 0, "paused": 0, "working": 0,
                    "tabs": 0, "windows": 0, "summary": "Orbit not running", "sessions": []}
        shape = json.dumps(line, sort_keys=True)
        if shape != previous:
            previous = shape
            line["sampledAt"] = datetime.now(timezone.utc).isoformat()
            print(json.dumps(line), flush=True)
        time.sleep(interval)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
