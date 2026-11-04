import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the desktop panel's broker half, which is Python and GTK on the person's own desktop");
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The half of the panel that speaks to Orbit, exercised the way `tests/settings.test.ts` exercises the
 * settings schema: by running the Python. Before `desktop/panel_broker.py` was split out of
 * `desktop/panel.py`, none of this could be reached without a display, so none of it was tested.
 *
 * Nothing here draws, and nothing here touches the person's own panel: every socket is inside a
 * directory this test made.
 */
async function python(code: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn(["/usr/bin/python3", "-c", code], {
    env: { ...process.env, ...environment, PYTHONPATH: resolve("desktop") }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (await child.exited !== 0) throw new Error(`python failed: ${err.trim().split("\n").at(-1)}`);
  return JSON.parse(out || "null");
}

test("the status the panel renders from carries presence only when something will read it", async () => {
  // A fake broker client, so the shape is tested rather than the transport. `session.presence` is a
  // second call per open session, which is why the collapsed mark does not ask for it every second.
  const result = await python(`
import json
from panel_broker import read_status, session_shape

class Client:
    def __init__(self):
        self.calls = []
    def call(self, method, params=None):
        self.calls.append(method)
        if method == "session.list":
            return [
                {"sessionId": "a", "state": "running", "backend": "browser", "agentName": "Claude",
                 "taskName": "one", "activity": {"state": "working"}, "surface": {"width": 1280, "height": 800}},
                {"sessionId": "b", "state": "closed", "backend": "browser", "agentName": "Other", "taskName": "gone"},
            ]
        return {"title": "A page", "location": "https://example.test/", "tabs": [{"tab": 1}], "pointer": {"x": 4, "y": 5}}

with_presence = Client()
without = Client()
full = read_status(with_presence, True)
lean = read_status(without, False)
print(json.dumps({
    "withCalls": with_presence.calls,
    "withoutCalls": without.calls,
    "open": [s["sessionId"] for s in full],
    "title": full[0].get("presence", {}).get("title"),
    "leanPresence": lean[0].get("presence"),
    "shapeChanges": session_shape(full) != session_shape([{**full[0], "taskName": "two"}]),
    "shapeStable": session_shape(full) == session_shape(full),
}))
`);
  // A closed session is not something the mark counts.
  expect(result.open).toEqual(["a"]);
  expect(result.withCalls).toEqual(["session.list", "session.presence"]);
  expect(result.withoutCalls).toEqual(["session.list"]);
  expect(result.title).toBe("A page");
  expect(result.leanPresence).toBeNull();
  // The shape is what decides whether the panel repaints, so it must move with what is drawn.
  expect(result.shapeChanges).toBe(true);
  expect(result.shapeStable).toBe(true);
});

test("the second panel hands its request to the first instead of starting a second mark", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "orbit-panel-claim-"));
  try {
    const result = await python(`
import json
from panel_broker import claim_the_mark, command_socket_path

# The first invocation owns the mark and gets a listener to read requests from.
listener, first = claim_the_mark("ping")
# The second finds it and hands over rather than drawing.
_, second = claim_the_mark("settings")
# The mark socket is a datagram socket, so the request arrives without a connection.
message = listener.recv(64).decode() if listener is not None else None
print(json.dumps({"first": first, "second": second, "handed": message,
                  "socketInRuntime": command_socket_path().startswith(${JSON.stringify(runtime)})}))
`, { XDG_RUNTIME_DIR: runtime });
    expect(result.first).toBe("owner");
    expect(result.second).toBe("handed");
    // What the running panel receives is the verb, which is how `sbar-orbit settings` reaches it.
    expect(result.handed).toBe("settings");
    expect(result.socketInRuntime).toBe(true);
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test("a stale socket no living panel answers is taken over, not deferred to", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "orbit-panel-stale-"));
  try {
    const result = await python(`
import json, os, socket
from panel_broker import claim_the_mark, command_socket_path

# What a killed panel leaves behind: the socket file, with nothing listening on it.
path = command_socket_path()
os.makedirs(os.path.dirname(path), exist_ok=True)
dead = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
dead.bind(path)
dead.close()
listener, outcome = claim_the_mark("ping")
print(json.dumps({"outcome": outcome, "listening": listener is not None}))
`, { XDG_RUNTIME_DIR: runtime });
    expect(result.outcome).toBe("owner");
    expect(result.listening).toBe(true);
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test("the viewer link is opened only when it is the loopback one Orbit printed", async () => {
  const result = await python(`
import json
from panel_broker import viewer_link_is_local
token = "t" * 32
cases = ["http://127.0.0.1:8787/#" + token, "http://127.0.0.1:8787/#short", "http://127.0.0.1:8787/",
         "http://localhost:8787/#" + token, "https://example.test/#" + token,
         "http://127.0.0.1.example.test/#" + token, "file:///etc/passwd", "", "not a url"]
print(json.dumps({case: bool(viewer_link_is_local(case)) for case in cases}))
`);
  const token = "t".repeat(32);
  // The loopback host, the port, and a token fragment long enough to be one.
  expect(result[`http://127.0.0.1:8787/#${token}`]).toBe(true);
  // No token, or a fragment too short to be one, is not the link Orbit printed.
  expect(result["http://127.0.0.1:8787/#short"]).toBe(false);
  expect(result["http://127.0.0.1:8787/"]).toBe(false);
  // localhost is not accepted even with a token: what the broker prints is the address, not the name.
  expect(result[`http://localhost:8787/#${token}`]).toBe(false);
  expect(result[`https://example.test/#${token}`]).toBe(false);
  // A host that merely begins with the loopback address is somebody else's.
  expect(result[`http://127.0.0.1.example.test/#${token}`]).toBe(false);
  expect(result["file:///etc/passwd"]).toBe(false);
  expect(result[""]).toBe(false);
  expect(result["not a url"]).toBe(false);
});

test("the panel presents the owner credential next to the socket, and only while it is private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-owner-credential-"));
  try {
    const result = await python(`
import json, os
from panel_broker import owner_credential, request_once

path = os.path.join(os.environ["DIR"], "broker.sock")
token = "ab" * 32
open(path + ".owner", "w").write(token + "\\n")
os.chmod(path + ".owner", 0o600)
found = owner_credential(path)
os.chmod(path + ".owner", 0o644)
loose = owner_credential(path)
os.chmod(path + ".owner", 0o600)
open(path + ".owner", "w").write("not a token\\n")
junk = owner_credential(path)
missing = owner_credential(os.path.join(os.environ["DIR"], "other.sock"))

class Connection:
    def request(self, verb, target, body=None, headers=None):
        self.headers = headers
    def getresponse(self):
        class Reply:
            def read(self, size):
                return b'{"ok": true, "result": 1}'
        return Reply()
with_token, without = Connection(), Connection()
request_once(with_token, "session.list", None, token)
request_once(without, "session.list", None)
print(json.dumps({"found": found == token, "loose": loose, "junk": junk, "missing": missing,
                  "sent": with_token.headers.get("X-Orbit-Owner") == token, "not_sent": "X-Orbit-Owner" not in without.headers}))
`, { DIR: directory });
    expect(result).toEqual({ found: true, loose: null, junk: null, missing: null, sent: true, not_sent: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("owner read view status asks only bounded metadata and leaves capture and controls untouched", async () => {
  const result = await python(`
import json
from panel_broker import read_owner_view_status
class Client:
    def __init__(self): self.calls = []
    def call(self, method, params=None):
        self.calls.append([method, params])
        if method != "views.owner-status": raise AssertionError("Not metadata")
        return {"available": False, "enabled": False, "activeChannels": 0, "readViews": 0}
client = Client()
print(json.dumps({"status": read_owner_view_status(client), "calls": client.calls}))
`);
  expect(result).toEqual({ status: { available: false, enabled: false, activeChannels: 0, readViews: 0 }, calls: [["views.owner-status", {}]] });
});

test("old broker denial and unreachable owner status never expose private errors or stale active counts", async () => {
  const result = await python(`
import json
from panel_broker import BrokerError, read_owner_view_status
class Client:
    def __init__(self, failure): self.failure = failure
    def call(self, method, params=None): raise self.failure
errors = [BrokerError("private-token-and-PID-424242", "UNSUPPORTED"), BrokerError("private-owner-secret", "OWNER_REQUIRED"), OSError("private-socket-path")]
print(json.dumps([read_owner_view_status(Client(error)) for error in errors]))
`);
  expect(result).toEqual(Array.from({ length: 3 }, () => ({ available: false, enabled: false, activeChannels: 0, readViews: 0 })));
  expect(JSON.stringify(result)).not.toContain("private");
});

test("owner counter normalizer rejects extra secrets malformed types unsafe counts and inconsistent availability", async () => {
  const result = await python(`
import json
from panel_broker import normalize_read_views, unavailable_read_views
base = unavailable_read_views()
cases = [None, [], {}, {**base, "token": "private-secret"}, {**base, "available": 1}, {**base, "enabled": "false"},
         {**base, "activeChannels": True}, {**base, "readViews": -1}, {**base, "readViews": 9},
         {**base, "activeChannels": 1.5}, {**base, "enabled": True}, {**base, "activeChannels": 1},
         {**base, "available": True, "readViews": 1}]
print(json.dumps([normalize_read_views(item) == base for item in cases]))
`);
  expect(result).toEqual(Array(13).fill(true));
});

test("read view summaries distinguish unavailable off no active views and qualified owner counters in English and Arabic", async () => {
  const result = await python(`
import json
from panel_broker import read_view_summary
states = [{"available": False, "enabled": False, "activeChannels": 0, "readViews": 0},
          {"available": True, "enabled": False, "activeChannels": 0, "readViews": 0},
          {"available": True, "enabled": True, "activeChannels": 0, "readViews": 0},
          {"available": True, "enabled": True, "activeChannels": 2, "readViews": 3}]
print(json.dumps({lang: [read_view_summary(item, lang) for item in states] for lang in ["en", "ar"]}))
`);
  expect(result.en).toEqual(["Multi-view reads: Not available", "Multi-view reads: Off", "Multi-view reads: On, no active views", "Multi-view reads: Active: 2 channels, 3 views"]);
  expect(result.ar[0]).toContain("غير متاحة"); expect(result.ar[1]).toContain("متوقفة");
  expect(result.ar[3]).toContain("2"); expect(result.ar[3]).toContain("3");
  expect(JSON.stringify(result)).not.toMatch(/[٠-٩]/);
});

test("metadata status uses the ordinary owner credential header and agent refusal stays unavailable", async () => {
  const result = await python(`
import json
from panel_broker import request_once, read_owner_view_status
class Connection:
    def __init__(self): self.headers = {}; self.request_body = None
    def request(self, verb, target, body=None, headers=None): self.headers, self.request_body = headers, json.loads(body)
    def getresponse(self):
        owner = self.headers.get("X-Orbit-Owner") == "ab" * 32
        class Reply:
            def read(self, size):
                return json.dumps({"ok": True, "result": {"available": False, "enabled": False, "activeChannels": 0, "readViews": 0}} if owner
                                  else {"ok": False, "error": {"code": "OWNER_REQUIRED", "message": "private-agent-refusal"}}).encode()
        return Reply()
class Client:
    def __init__(self, token): self.token, self.connection = token, Connection()
    def call(self, method, params=None): return request_once(self.connection, method, params, self.token)
owner, agent = Client("ab" * 32), Client(None)
a, b = read_owner_view_status(owner), read_owner_view_status(agent)
print(json.dumps({"owner": a, "agent": b, "sent": owner.connection.headers.get("X-Orbit-Owner") == "ab" * 32,
                  "agentHasOwner": "X-Orbit-Owner" in agent.connection.headers, "body": owner.connection.request_body}))
`);
  expect(result.sent).toBe(true); expect(result.agentHasOwner).toBe(false);
  expect(result.owner).toEqual(result.agent);
  expect(result.body).toEqual({ method: "views.owner-status", params: {} });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("status normalization copies only metadata without mutating the broker payload or creating work", async () => {
  const result = await python(`
import json
from unittest.mock import patch
from panel_broker import normalize_read_views, read_owner_view_status
payload = {"available": True, "enabled": True, "activeChannels": 1, "readViews": 2}
class Client:
    def call(self, method, params=None): return payload
with patch("subprocess.Popen", side_effect=AssertionError("No worker")), patch("subprocess.run", side_effect=AssertionError("No capture")), patch("threading.Thread", side_effect=AssertionError("No thread")):
    status = read_owner_view_status(Client())
    status["readViews"] = 0
print(json.dumps({"source": payload, "fresh": normalize_read_views(None) is not normalize_read_views(None)}))
`);
  expect(result).toEqual({ source: { available: true, enabled: true, activeChannels: 1, readViews: 2 }, fresh: true });
});
