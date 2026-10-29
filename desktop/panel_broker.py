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

    def __init__(self, path, timeout=3):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class BrokerError(RuntimeError):
    """The broker answered and said no. The code is what lets the panel tell a refusal that is only
    information (SESSION_OPEN: end the session first) from one that is a fault, and it subclasses
    RuntimeError so the poll loop's reconnect logic, which re-raises those, is untouched."""

    def __init__(self, message, code=""):
        super().__init__(message)
        self.code = code


def request_once(connection, method, params):
    connection.request("POST", "/rpc", body=json.dumps({"method": method, "params": params or {}}),
                       headers={"Content-Type": "application/json"})
    payload = json.loads(connection.getresponse().read(1 << 20))
    if not payload.get("ok"):
        failure = payload.get("error") or {}
        raise BrokerError(failure.get("message", "Broker request failed"), failure.get("code", ""))
    return payload["result"]


def rpc(path, method, params=None, timeout=3):
    """One off connection. The poll loop uses BrokerClient instead. Never call this from the GTK main
    thread: pause waits for the session's action queue and can outlast any timeout worth blocking on."""
    connection = UnixConnection(path, timeout)
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


def read_sessions(client, with_presence=True):
    """Open sessions, and separately the ones that are over. A closed session is not something the mark
    counts, but it stays listed so the person can read how it ended and remove it. Presence is asked of
    open sessions only: the broker answers SESSION_CLOSED to a closed one, which would be an error per
    poll for as long as the card stays."""
    listed = [s for s in client.call("session.list") if isinstance(s, dict) and isinstance(s.get("sessionId"), str)]
    sessions = [s for s in listed if s.get("state") not in ("closed", "closing")]
    ended = [s for s in listed if s.get("state") in ("closed", "closing")]
    for session in listed:
        session["presence"] = None
    if with_presence:
        for session in sessions:
            try:
                presence = client.call("session.presence", {"sessionId": session["sessionId"]})
                session["presence"] = presence if isinstance(presence, dict) else None
            except Exception:
                pass
    return sessions, ended


def read_status(client, with_presence=True):
    """The open session list, and presence only when something is going to read it. The collapsed mark
    takes its colour from the list alone, so presence is one call per session that nobody sees."""
    return read_sessions(client, with_presence)[0]


# The controls. Each takes its own connection with room to wait: a pause is acknowledged only after the
# session's queued action finishes, which is longer than the poll connection's three seconds. They run
# on a worker thread the panel starts, never on the GTK thread.
ACTION_TIMEOUT = 30


def session_action(path, verb, session_id):
    if verb not in ("pause", "resume", "stop", "forget"):
        raise ValueError(f"unknown session action {verb}")
    return rpc(path, f"session.{verb}", {"sessionId": session_id}, ACTION_TIMEOUT)


def journal_rows(payload, limit=12):
    """The newest actions first, reduced to what the detail view shows: when, what, and how it ended.
    A denial carries the broker's reason; an allowed action carries nothing more, by design."""
    entries = payload.get("entries") if isinstance(payload, dict) else None
    rows = []
    for entry in reversed([e for e in (entries or []) if isinstance(e, dict)]):
        if len(rows) >= limit:
            break
        rows.append({"at": entry.get("at"), "sequence": entry.get("sequence"), "actor": entry.get("actor", ""),
                     "action": str(entry.get("actionType", "")), "outcome": str(entry.get("outcome", "")),
                     "reason": str(entry.get("reason", ""))})
    return rows


def read_journal(client, session_id, limit=12):
    """Works for a closed session too: the broker answers the journal before it checks the session is open."""
    return journal_rows(client.call("session.journal", {"sessionId": session_id}), limit)


# What a pasted report may carry. Window titles, task text, agent names and the journal's path are the
# owner's own content and a personal path, which docs/diagnostics.md says a public report omits.
def build_report(doctor, session, rows):
    outcomes = {}
    for row in rows:
        key = f"{row['action']}:{row['outcome']}"
        outcomes[key] = outcomes.get(key, 0) + 1
    handoff = session.get("handoff") or {}
    facts = {"state": session.get("state"), "activity": (session.get("activity") or {}).get("state"),
             "workspace": handoff.get("workspace"), "handoffScope": handoff.get("scope"),
             "clipboard": handoff.get("clipboard"), "windows": len(handoff.get("windows") or []),
             "recentActions": outcomes}
    return json.dumps({**(doctor or {}), "session": facts}, indent=2, ensure_ascii=False)


def viewer_link_is_local(url):
    """The only link the panel will open: the broker's own loopback viewer with its token fragment.
    Parsed rather than prefix-matched, so a userinfo trick such as http://127.0.0.1:80@other/ is refused."""
    if not isinstance(url, str):
        return False
    from urllib.parse import urlsplit
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (parts.scheme == "http" and parts.hostname == "127.0.0.1" and parts.username is None
            and parts.password is None and port is not None and 0 < port < 65536
            and parts.netloc == f"127.0.0.1:{port}" and len(parts.fragment) >= 32)


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
                             (s.get("presence") or {}).get("title", ""), len((s.get("presence") or {}).get("tabs") or []),
                             (s.get("handoff") or {}).get("workspace"))
            for s in sessions if isinstance(s.get("sessionId"), str)}

