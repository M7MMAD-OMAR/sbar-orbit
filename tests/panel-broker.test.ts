import { test, expect } from "bun:test";
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
