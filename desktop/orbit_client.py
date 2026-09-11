"""The broker client the desktop pieces share.

The panel and the bar stream both want the same two things from the broker: the session list, and
presence for the sessions whose detail is about to be read. Both talk HTTP over the broker's Unix
socket, which is the only interface it has, and both hold one connection open rather than paying for
two socket lifetimes a second.

Nothing here imports a toolkit, so a bar module can run it without pulling in GTK.
"""
import http.client
import json
import os
import socket


class UnixConnection(http.client.HTTPConnection):
    """HTTP over the broker's Unix socket, which is how every Orbit client reaches it."""

    def __init__(self, path, timeout=3):
        super().__init__("localhost", timeout=timeout)
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
        for attempt in (0, 1):
            try:
                if self.connection is None:
                    self.connection = UnixConnection(self.path)
                    self.connection.connect()
                return request_once(self.connection, method, params)
            except RuntimeError:
                raise
            except Exception:
                # A broker restart or an idle timeout closes the socket under us; reconnect once.
                self.close()
                if attempt:
                    raise
        return None

    def close(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass
            self.connection = None


def broker_socket(env=None):
    env = os.environ if env is None else env
    if env.get("ORBIT_SOCKET"):
        return env["ORBIT_SOCKET"]
    runtime = env.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "sbar-orbit", "broker.sock")


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


def session_shape(sessions):
    """What a mark and its cards actually read. Comparing this instead of the whole payload keeps a
    live pointer position or an activity counter from redrawing under the person's hand."""
    return {s["sessionId"]: (s.get("agentName", "Agent"), s.get("taskName", ""), s.get("state", ""),
                             (s.get("activity") or {}).get("state", ""), (s.get("activity") or {}).get("type", ""),
                             (s.get("presence") or {}).get("title", ""), len((s.get("presence") or {}).get("tabs") or []))
            for s in sessions if isinstance(s.get("sessionId"), str)}


def counts(sessions):
    """The numbers a bar puts on screen, from one pass over the list."""
    tally = {"running": 0, "paused": 0, "working": 0, "tabs": 0, "windows": 0}
    for session in sessions:
        if session.get("state") == "running":
            tally["running"] += 1
        if session.get("state") == "paused":
            tally["paused"] += 1
        if (session.get("activity") or {}).get("state") == "working":
            tally["working"] += 1
        open_views = len((session.get("presence") or {}).get("tabs") or [])
        tally["windows" if session.get("backend") == "fedora" else "tabs"] += open_views
    return tally


def summarize(sessions, tally):
    """A short line for a bar, the same wording `sbar-orbit status` prints."""
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
