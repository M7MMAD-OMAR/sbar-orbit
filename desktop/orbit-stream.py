#!/usr/bin/python3
"""One compact JSON line on standard output whenever what a bar would show changes.

This is the feed a shell module reads. It exists rather than reusing `sbar-orbit status --watch`,
which prints a related but not identical shape, because that one starts a Bun runtime measured at
117 MB resident where this process measures 17 MB, and a bar widget should not cost more than the
desktop it decorates.

A line is printed at startup, then only when something changes, so a quiet desktop is a quiet pipe.
Timestamps are excluded from that comparison, or every second would be a change.

    orbit-stream.py                 stream until killed
    orbit-stream.py --open-viewer   ask the broker for a viewer link and open it, then exit

The link carries a fresh access token, so it is requested at the moment of the click and never
written down, and only a loopback link is ever opened.

The shape:

    {"socket": "...", "sampledAt": "...", "reachable": true, "running": 1, "paused": 0,
     "working": 0, "tabs": 0, "windows": 2, "summary": "1 session · 2 windows",
     "sessions": [{"sessionId": "...", "agentName": "...", "taskName": "...", "state": "running",
                   "backend": "fedora", "activityState": "done", "title": "...", "views": 2}]}

and when the broker is not there, the same keys with `reachable` false, zero counts, no sessions and
the summary "Orbit not running".
"""
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

from orbit_client import BrokerClient, broker_socket, counts, read_status, rpc, summarize, viewer_link_is_local

INTERVAL_SECONDS = 1.0
# Presence is the expensive half: a compositor tree query for a private display, and two round trips
# that wake the headless browser for a browser session. The capsule's colour comes from the session
# list alone, and the title and the view count are read in a popup that is open for a moment, so
# fetching it every second would wake every agent's browser all day for something nobody is looking
# at. The panel makes the same trade at ten seconds while its cards are closed.
PRESENCE_SECONDS = 5.0


def snapshot(client, with_presence, carried):
    """One line's worth of state. `carried` holds the presence from the last read that asked for it,
    and is updated in place, so the counts and titles do not blink to empty between those reads."""
    sessions = read_status(client, with_presence)
    if with_presence:
        carried.clear()
        carried.update({s["sessionId"]: s["presence"] for s in sessions})
    else:
        for session in sessions:
            session["presence"] = carried.get(session.get("sessionId"))
    tally = counts(sessions)
    return {"socket": client.path, "reachable": True, **tally,
            "summary": summarize(sessions, tally),
            "sessions": [{"sessionId": s.get("sessionId"), "agentName": s.get("agentName"), "taskName": s.get("taskName"),
                          "state": s.get("state"), "backend": s.get("backend"),
                          "activityState": (s.get("activity") or {}).get("state"),
                          "title": (s.get("presence") or {}).get("title"),
                          "views": len((s.get("presence") or {}).get("tabs") or [])}
                         for s in sessions]}


def unreachable(path):
    return {"socket": path, "reachable": False, "running": 0, "paused": 0, "working": 0,
            "tabs": 0, "windows": 0, "summary": "Orbit not running", "sessions": []}


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
    path = broker_socket()
    if "--open-viewer" in sys.argv:
        return open_viewer(path)
    if "-h" in sys.argv or "--help" in sys.argv:
        print(__doc__.strip())
        return 0
    client = BrokerClient(path)
    previous, presence_due, carried = None, 0.0, {}
    while True:
        with_presence = time.monotonic() >= presence_due
        try:
            line = snapshot(client, with_presence, carried)
            if with_presence:
                presence_due = time.monotonic() + PRESENCE_SECONDS
        except Exception:
            client.close()
            line = unreachable(path)
            carried.clear()
        shape = json.dumps(line, sort_keys=True)
        if shape != previous:
            previous = shape
            line["sampledAt"] = datetime.now(timezone.utc).isoformat()
            print(json.dumps(line), flush=True)
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
