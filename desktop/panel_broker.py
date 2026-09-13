"""How the panel reaches the broker, and how one panel claims the mark.

Split out of `panel.py` so the half that speaks to Orbit can be read, and tested, without a display.
Nothing here imports GTK: it is HTTP over a Unix socket, the status shape the panel renders from, the
command socket a second invocation hands its request to, and the two desktop helpers that shell out.
"""
import http.client
import json
import os
import socket
import subprocess
import sys


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
    """One off, for the main thread. The poll loop uses BrokerClient instead."""
    connection = UnixConnection(path)
    try:
        return request_once(connection, method, params)
    finally:
        connection.close()


class BrokerClient:
    """One connection held open for the poll loop. A fresh connection per call cost two socket
    lifetimes a second and doubled the latency of every presence read: measured, a kept connection
    takes a presence call from 0.39 ms to 0.19 ms. Used from the poll thread only."""

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


def broker_socket():
    if os.environ.get("ORBIT_SOCKET"):
        return os.environ["ORBIT_SOCKET"]
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "sbar-orbit", "broker.sock")


def read_status(client, with_presence=True):
    """The session list, and presence only when something is going to read it. The collapsed mark
    takes its colour from the list alone, so presence is one call per session that nobody sees."""
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


def viewer_link_is_local(url):
    """The only link the panel will open: the broker's own loopback viewer with its token fragment."""
    return isinstance(url, str) and url.startswith("http://127.0.0.1:") and "#" in url and len(url.split("#", 1)[1]) >= 32


def launcher_json(args):
    """Ask the launcher something and read its JSON answer, or None when it could not answer.

    The panel is Python and the units are TypeScript, and the state this asks about, what systemd has
    enabled and which desktop entries exist, has exactly one owner. A second implementation here would be
    a second opinion about whether Orbit starts at login.
    """
    launcher = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "sbar-orbit")
    try:
        finished = subprocess.run([launcher, *args], capture_output=True, text=True, timeout=45)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"panel: could not run {' '.join(args)} ({error})", file=sys.stderr)
        return None
    try:
        return json.loads(finished.stdout)
    except ValueError:
        print(f"panel: {' '.join(args)} did not answer with JSON: {finished.stderr.strip()[:200]}", file=sys.stderr)
        return None


def command_socket_path():
    """Where a panel listens for another invocation's request.

    ORBIT_PANEL_SOCKET overrides it. That exists because the runtime directory cannot be moved to test
    this: it is also where libwayland looks for the compositor, so a panel pointed at a different one
    finds no display at all.
    """
    override = os.environ.get("ORBIT_PANEL_SOCKET")
    if override:
        return override
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "sbar-orbit", "panel.sock")


def claim_the_mark(message):
    """One panel per desktop, and a way to talk to the one that is already there.

    Two mechanisms in one, because they answer the same question. Binding this socket is how a panel
    claims the mark: a second one cannot bind, so it sends its request to the first and leaves. That is
    what makes it safe to enable both autostart paths at once, and what makes `sbar-orbit settings` work
    whether or not a panel is running.

    A second copy leaves with status zero on purpose. A systemd unit with Restart=on-failure would
    otherwise retry the loser forever.
    """
    path = command_socket_path()
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    except OSError as error:
        # No runtime directory means no single instance guard, which is worth a line and not worth
        # refusing to draw over.
        print(f"panel: no runtime directory for the command socket ({error}); running without one", file=sys.stderr)
        return None, "unsupported"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    for attempt in (1, 2):
        try:
            listener.bind(path)
            os.chmod(path, 0o600)
            return listener, "owner"
        except OSError:
            # Either a panel is running or one died and left its socket file. A datagram tells them apart:
            # nothing is listening on a stale path, so the send fails rather than disappearing.
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            try:
                probe.sendto(message.encode(), path)
                listener.close()
                return None, "handed"
            except OSError:
                if attempt == 2:
                    listener.close()
                    return None, "unsupported"
                try:
                    os.unlink(path)
                except OSError:
                    pass
            finally:
                probe.close()
    return None, "unsupported"



def notify(title, body):
    """A desktop notification through the person's own daemon, so it looks like every other one."""
    try:
        subprocess.Popen(["notify-send", "--app-name=Sbar Orbit", "--expire-time=4000", title, body],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def session_shape(sessions):
    """What the mark and the cards actually read. Comparing this instead of the whole payload keeps a
    live pointer position or an activity counter from rebuilding the cards under the person's hand."""
    return {s["sessionId"]: (s.get("agentName", "Agent"), s.get("taskName", ""), s.get("state", ""),
                             (s.get("activity") or {}).get("state", ""), (s.get("activity") or {}).get("type", ""),
                             (s.get("presence") or {}).get("title", ""), len((s.get("presence") or {}).get("tabs") or []))
            for s in sessions if isinstance(s.get("sessionId"), str)}

