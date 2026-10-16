#!/usr/bin/python3
"""One compact JSON line on standard output whenever what a bar would show changes.

This is the feed a shell module reads. It exists rather than reusing `sbar-orbit status --watch`,
which prints a related but not identical shape, because a bar widget should not cost more than the
desktop it decorates. Measured side by side on this workstation, `sbar-orbit status --watch` holds
117 MB resident and spends 1.3% of one core, this helper 18 MB and 0.04%. Resident memory overstates
the gap when other Bun processes are sharing the runtime's pages, so the honest number is the
processor one: about thirty times less.

A line is printed at startup, then only when something changes, so a quiet desktop is a quiet pipe.
Timestamps are excluded from that comparison, or every second would be a change. The wait between
reads stretches when nothing is happening, because a bar that is drawing nothing needs no news.

    orbit-stream.py                 stream until killed
    orbit-stream.py --open-viewer   show desktop sessions in the native panel, then exit

The shell click starts the native panel. Browser links and browser fallbacks are retired.

The shape:

    {"socket": "...", "sampledAt": "...", "reachable": true, "running": 1, "paused": 0,
     "working": 0, "tabs": 0, "windows": 2, "summary": "1 session · 2 windows",
     "sessions": [{"sessionId": "...", "agentName": "...", "taskName": "...", "state": "running",
                   "backend": "fedora", "activityState": "done", "title": "...", "views": 2}]}

and when the broker is not there, the same keys with `reachable` false, zero counts, no sessions and
the summary "Orbit not running".
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

from orbit_client import BrokerClient, broker_socket, counts, read_status, summarize

# Compositor presence queries are needed while session details are visible. Polling them less often
# while the capsule is collapsed keeps idle overhead down. A new window can take up to ten seconds
# to appear in this feed.
PRESENCE_SECONDS = 10.0


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


def interval(line):
    """How long to wait before the next read. The helper wakes 86,400 times a day at a flat second,
    and a bar whose capsule is hidden because nothing is running has no use for any of them."""
    if not line["reachable"]:
        return 5.0
    if line["working"]:
        return 1.0
    return 2.0 if line["sessions"] else 3.0


def unreachable(path):
    return {"socket": path, "reachable": False, "running": 0, "paused": 0, "working": 0,
            "tabs": 0, "windows": 0, "summary": "Orbit not running", "sessions": []}


def open_viewer(path):
    """Route the shell click to the native panel without requesting a URL."""
    try:
        subprocess.Popen([sys.executable, str(Path(__file__).with_name('panel.py')), '--sessions'],
                         env={**os.environ, 'ORBIT_SOCKET': path}, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError as error:
        print(f"orbit-stream: native panel could not start: {error}", file=sys.stderr)
        return 1
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
        time.sleep(interval(line))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
