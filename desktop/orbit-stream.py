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
    orbit-stream.py --open-viewer   ask the broker to open the viewer in its own window, then exit

The link carries a fresh access token, so it is requested at the moment of the click and never
written down, and only a loopback link is ever opened. The broker opens it in a browser window that
is Orbit's own, never a tab of the person's browser; xdg-open is only the fallback for a broker that
is too old to do that.

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

# Presence is the expensive half. For a private display it is a compositor tree query, 0.18 ms all
# told; for a browser session it is two round trips that wake the headless renderer, measured at 5.3
# to 7.0 ms of processor time per call, and browser is the default backend. Nothing on the collapsed
# capsule depends on it: the colour comes from the session list, and the title and the view count are
# read in a popup that is open for a moment. So it is read every ten seconds, the same trade the
# panel makes while its cards are closed. The cost is that a blink for a newly opened window can be
# up to ten seconds late, which is the latency the panel already ships with.
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
    """The broker opens the viewer in a window of Orbit's own, in the browser and the app window
    setting the panel's settings name. Until 14 September 2026 this handed the link to xdg-open,
    which is the person's default browser and their own profile, the one place the viewer must not
    open; and from a shell that carries no xdg-open on its PATH it opened nothing and said nothing.
    The launcher below is the fallback for a broker too old to open the viewer itself."""
    try:
        from orbit_settings import load
        settings, _ = load()
    except Exception:
        settings = {}
    try:
        answer = rpc(path, "preview.open", {"launch": True,
                                            "browser": settings.get("viewerBrowser", ""),
                                            "appWindow": settings.get("viewerAppWindow", True)})
    except Exception as error:
        print(f"orbit-stream: could not open the viewer: {error}", file=sys.stderr)
        return 1
    url = answer.get("url", "") if isinstance(answer, dict) else ""
    if not viewer_link_is_local(url):
        print("orbit-stream: the broker returned something other than a local viewer link", file=sys.stderr)
        return 1
    if answer.get("opened"):
        print(f"orbit-stream: viewer opened in {answer.get('browser') or 'the chosen browser'}"
              f"{' as a window of its own' if answer.get('appWindow') else ' as a tab'}", file=sys.stderr)
        return 0
    print("orbit-stream: the broker did not open the viewer; handing the link to the desktop", file=sys.stderr)
    try:
        subprocess.Popen(["xdg-open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as error:
        print(f"orbit-stream: xdg-open is not available: {error}", file=sys.stderr)
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
