"""The broker client the desktop pieces talk through.

The bar helper wants two things from the broker: the session list, and presence for the sessions
whose detail is about to be read. Both go over HTTP on the broker's Unix socket, which is the only
interface it has, and a loop should hold one connection open rather than paying for two socket
lifetimes a second.

Nothing here imports a toolkit, so a bar module can use it without pulling in GTK. `desktop/panel.py`
still carries its own copy of this client and should import this one instead; that change is waiting
on the panel, not on this file.
"""
import http.client
import json
import os
import socket


class UnixConnection(http.client.HTTPConnection):
    """HTTP over the broker's Unix socket, which is how every Orbit client reaches it."""

    def __init__(self, path):
        super().__init__("localhost", timeout=3)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def request_once(connection, method, params):
    connection.request("POST", "/rpc", body=json.dumps({"method": method, "params": params or {}}),
                       headers={"Content-Type": "application/json"})
    payload = json.loads(connection.getresponse().read(1 << 20))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error", {}).get("message", "Broker request failed"))
    return payload["result"]


def rpc(path, method, params=None):
    """One off, for a caller that has no loop. A loop should use BrokerClient instead."""
    connection = UnixConnection(path)
    try:
        return request_once(connection, method, params)
    finally:
        connection.close()


class BrokerClient:
    """One connection held open for a polling loop. A fresh connection per call cost two socket
    lifetimes a second and doubled the latency of every presence read: measured, a kept connection
    takes a presence call from 0.39 ms to 0.19 ms. Use one client per thread."""

    def __init__(self, path):
        self.path = path
        self.connection = None

    def call(self, method, params=None):
        try:
            return self._attempt(method, params)
        except RuntimeError:
            raise
        except Exception:
            # A broker restart or an idle timeout closes the socket under us; reconnect once.
            self.close()
            return self._attempt(method, params)

    def _attempt(self, method, params):
        if self.connection is None:
            self.connection = UnixConnection(self.path)
            self.connection.connect()
        return request_once(self.connection, method, params)

    def close(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass
            self.connection = None


def broker_socket():
    if os.environ.get("ORBIT_SOCKET"):
        return os.environ["ORBIT_SOCKET"]
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "sbar-orbit", "broker.sock")


def viewer_link_is_local(url):
    """The only link a desktop piece will open: the broker's own loopback viewer with its token
    fragment. This decides which URLs may be launched, so it lives in one place on purpose."""
    return isinstance(url, str) and url.startswith("http://127.0.0.1:") and "#" in url and len(url.split("#", 1)[1]) >= 32


def read_status(client, with_presence=True):
    """The session list, and presence only when something is going to read it. A mark that shows
    nothing but a colour takes it from the list alone, so presence is one call per session nobody sees."""
    sessions = [s for s in client.call("session.list") if isinstance(s, dict) and s.get("state") not in ("closed", "closing")]
    for session in sessions:
        session["presence"] = None
        if with_presence:
            try:
                presence = client.call("session.presence", {"sessionId": session["sessionId"]})
                session["presence"] = presence if isinstance(presence, dict) else None
            except Exception:
                pass
    return sessions


def counts(sessions):
    """The numbers a bar puts on screen, from one pass over the list. The split between tabs and
    windows follows `summarize` in src/status.ts: browser sessions have tabs, private displays have
    windows, and a backend that is neither counts as neither."""
    tally = {"running": 0, "paused": 0, "working": 0, "tabs": 0, "windows": 0}
    for session in sessions:
        if session.get("state") == "running":
            tally["running"] += 1
        if session.get("state") == "paused":
            tally["paused"] += 1
        if (session.get("activity") or {}).get("state") == "working":
            tally["working"] += 1
        open_views = len((session.get("presence") or {}).get("tabs") or [])
        key = {"browser": "tabs", "fedora": "windows"}.get(session.get("backend"))
        if key:
            tally[key] += open_views
    return tally


def summarize(sessions, tally):
    """A short line for a bar, word for word what `sbar-orbit status` prints."""
    total = len(sessions)
    if not total:
        return "Orbit idle"
    parts = [f"{total} session{'' if total == 1 else 's'}"]
    for key, word in (("working", "working"), ("paused", "paused")):
        if tally[key]:
            parts.append(f"{tally[key]} {word}")
    for key, word in (("tabs", "tab"), ("windows", "window")):
        if tally[key]:
            parts.append(f"{tally[key]} {word}{'' if tally[key] == 1 else 's'}")
    return " · ".join(parts)
