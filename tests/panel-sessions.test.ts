import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the panel's session controls, which are Python on the person's own desktop");
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The broker half of the session controls, against a fake broker that speaks the real wire format over a
 * Unix socket: HTTP/1.1 with keep-alive, POST /rpc, `{ok, result}` or `{ok:false, error:{code,message}}`.
 * The widgets are not here; they are judged by rendering the panel, because an import check passes while a
 * widget still fails.
 */
async function python(code: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn(["/usr/bin/python3", "-c", code], {
    env: { ...process.env, ...environment, PYTHONPATH: resolve("desktop") }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (await child.exited !== 0) throw new Error(`python failed: ${err.trim().split("\n").at(-1)}`);
  return JSON.parse(out || "null");
}

const FAKE = `
import json, os, socketserver, threading
from http.server import BaseHTTPRequestHandler

SESSIONS = {
    "a": {"sessionId": "a", "state": "running", "agentName": "Claude", "taskName": "one", "activity": {"state": "working"},
          "lastActivityAt": 1793275200000, "handoff": {"workspace": 7, "scope": "entire-wayland-client", "clipboard": "shared", "windows": [{}, {}]}},
    "b": {"sessionId": "b", "state": "paused", "agentName": "Other", "taskName": "two"},
    "c": {"sessionId": "c", "state": "closed", "agentName": "Done", "taskName": "three"},
    "d": {"sessionId": "d", "state": "closing", "agentName": "Going", "taskName": "four"},
}
CALLS = []

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method, params = body["method"], body["params"]
        CALLS.append([method, params])
        sid = params.get("sessionId")
        reply = {"ok": True, "result": None}
        if method == "session.list":
            reply["result"] = list(SESSIONS.values())
        elif method == "session.presence":
            if SESSIONS[sid]["state"] in ("closed", "closing"):
                reply = {"ok": False, "error": {"code": "SESSION_CLOSED", "message": "Session is closed"}}
            else:
                reply["result"] = {"title": "A window", "tabs": [{"tab": 1}]}
        elif method == "session.forget":
            if SESSIONS.get(sid, {}).get("state") != "closed":
                reply = {"ok": False, "error": {"code": "SESSION_OPEN", "message": "End the session before removing it from the list"}}
            else:
                reply["result"] = {"sessionId": sid, "forgotten": True}
        elif method == "session.journal":
            reply["result"] = {"sessionId": sid, "path": "/var/lib/orbit/private.jsonl", "tainted": False, "entries": [
                {"sequence": i, "at": "2026-10-29T10:%02d:00.000Z" % i, "actor": "agent", "actionType": "click", "outcome": "allow"} for i in range(1, 16)
            ] + [{"sequence": 16, "at": "2026-10-29T10:16:00.000Z", "actor": "agent", "actionType": "text", "outcome": "deny", "reason": "Not allowed in this mode"}]}
        else:
            reply["result"] = {"sessionId": sid, "state": "ok"}
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    def get_request(self):
        request, _ = super().get_request()
        return request, ("local", 0)

def serve(path):
    server = Server(path, Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
`;

test("the controls send the right method and session to the broker, and a refusal keeps its code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-panel-fake-"));
  try {
    const result = await python(`
${FAKE}
import json
from panel_broker import BrokerError, session_action

path = os.path.join(${JSON.stringify(directory)}, "broker.sock")
serve(path)
for verb in ("pause", "resume", "stop"):
    session_action(path, verb, "a")
refused = None
try:
    session_action(path, "forget", "a")
except BrokerError as error:
    refused = {"code": error.code, "message": str(error)}
removed = session_action(path, "forget", "c")
unknown = None
try:
    session_action(path, "format", "a")
except ValueError as error:
    unknown = str(error)
print(json.dumps({"calls": CALLS, "refused": refused, "removed": removed, "unknown": unknown}))
`);
    expect(result.calls).toEqual([
      ["session.pause", { sessionId: "a" }], ["session.resume", { sessionId: "a" }], ["session.stop", { sessionId: "a" }],
      ["session.forget", { sessionId: "a" }], ["session.forget", { sessionId: "c" }],
    ]);
    // SESSION_OPEN is the broker declining, with a message meant for the person; the code is what lets
    // the panel show it as information rather than as a failure.
    expect(result.refused).toEqual({ code: "SESSION_OPEN", message: "End the session before removing it from the list" });
    expect(result.removed.forgotten).toBe(true);
    expect(result.unknown).toContain("unknown session action");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("closed sessions stay listed without presence, and the mark still counts only the open ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-panel-fake-"));
  try {
    const result = await python(`
${FAKE}
import json
from panel_broker import BrokerClient, read_sessions, read_status

path = os.path.join(${JSON.stringify(directory)}, "broker.sock")
serve(path)
client = BrokerClient(path)
open_sessions, ended = read_sessions(client, True)
presence_calls = [c[1]["sessionId"] for c in CALLS if c[0] == "session.presence"]
count = len(read_status(client, False))
print(json.dumps({"open": [s["sessionId"] for s in open_sessions], "ended": [s["sessionId"] for s in ended],
                  "presence": presence_calls, "title": open_sessions[0]["presence"]["title"],
                  "endedPresence": [s["presence"] for s in ended], "count": count}))
`);
    expect(result.open).toEqual(["a", "b"]);
    expect(result.ended).toEqual(["c", "d"]);
    // A presence call to a closed session is an error the broker answers every poll for as long as its card stays.
    expect(result.presence).toEqual(["a", "b"]);
    expect(result.title).toBe("A window");
    expect(result.endedPresence).toEqual([null, null]);
    expect(result.count).toBe(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the journal is newest first, capped, and the report leaves out titles, task text and the path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-panel-fake-"));
  try {
    const result = await python(`
${FAKE}
import json
from panel_broker import BrokerClient, build_report, read_journal

path = os.path.join(${JSON.stringify(directory)}, "broker.sock")
serve(path)
client = BrokerClient(path)
rows = read_journal(client, "c")
session = {**SESSIONS["a"], "presence": {"title": "Secret Document - Editor"}}
report = build_report({"report": "orbit-desktop-capabilities", "orbitVersion": "9.9.9"}, session, rows)
print(json.dumps({"count": len(rows), "first": rows[0], "last": rows[-1]["sequence"], "report": report}))
`);
    expect(result.count).toBe(12);
    expect(result.first).toMatchObject({ sequence: 16, action: "text", outcome: "deny", reason: "Not allowed in this mode" });
    expect(result.last).toBe(5);
    const report = JSON.parse(result.report);
    expect(report.orbitVersion).toBe("9.9.9");
    expect(report.session).toMatchObject({ state: "running", workspace: 7, handoffScope: "entire-wayland-client", clipboard: "shared", windows: 2 });
    expect(report.session.recentActions).toEqual({ "click:allow": 11, "text:deny": 1 });
    for (const secret of ["Secret Document", "one", "Claude", "private.jsonl", "/var/lib/orbit"])
      expect(result.report).not.toContain(secret);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("times are absolute, 12 hour, Latin digits, in both languages", async () => {
  const result = await python(`
import json
from datetime import datetime
from panel_text import clock, state_key, text

now = datetime(2026, 10, 29, 12, 0)
def ms(h, m, day=29):
    return datetime(2026, 10, day, h, m).timestamp() * 1000
print(json.dumps({
    "morning": clock(ms(7, 8), "en", now), "midnight": clock(ms(0, 5), "en", now), "noon": clock(ms(12, 0), "en", now),
    "evening": clock(ms(19, 8), "en", now), "arabic": clock(ms(19, 8), "ar", now), "yesterday": clock(ms(19, 8, 28), "en", now),
    "iso": clock("2026-10-29T10:56:03.041Z", "en", now), "none": clock(None), "junk": clock("later"),
    "states": [state_key({"state": "running"}), state_key({"state": "running", "activity": {"state": "working"}}),
               state_key({"state": "paused"}), state_key({"state": "closed"}), state_key({"state": "pausing"})],
    "arabicWord": text("pause", "ar"), "fallback": text("no-such-key", "ar"),
}))
`, { TZ: "UTC" });
  expect(result.morning).toBe("7:08 AM");
  expect(result.midnight).toBe("12:05 AM");
  expect(result.noon).toBe("12:00 PM");
  expect(result.evening).toBe("7:08 PM");
  expect(result.arabic).toBe("7:08 م");
  expect(result.yesterday).toBe("28/10 7:08 PM");
  expect(result.iso).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  expect(result.none).toBe("");
  expect(result.junk).toBe("");
  expect(result.states).toEqual(["idle", "working", "paused", "closed", "pausing"]);
  expect(result.arabicWord).toBe("إيقاف مؤقت");
  expect(result.fallback).toBe("no-such-key");
  // No Arabic-Indic digits and no guillemets anywhere in the vocabulary.
  const all = await python(`
import json
from panel_text import STRINGS
print(json.dumps(json.dumps(STRINGS, ensure_ascii=False)))
`);
  expect(all).not.toMatch(/[\u0660-\u0669\u00ab\u00bb\u2014\u2013]/);
});

test("the card order is creation order, and a list in use never reflows", async () => {
  const result = await python(`
import json
from panel_broker import card_plan, short_id, stable_order

sessions = [{"sessionId": "b", "createdAt": 20, "state": "running"}, {"sessionId": "a", "createdAt": 10, "state": "closed"},
            {"sessionId": "c", "createdAt": 30, "state": "running"}]
ordered = [s["sessionId"] for s in stable_order(sessions)]
# A session that ends keeps its place: the order does not depend on the state.
ended = [s["sessionId"] for s in stable_order([{**s, "state": "closed"} if s["sessionId"] == "b" else s for s in sessions])]
shown = ["a", "b"]
print(json.dumps({
    "ordered": ordered, "ended": ended,
    "free": card_plan(shown, ["a", "b", "c"], False),
    "frozen": card_plan(shown, ["a", "b", "c"], True),
    "frozenGone": card_plan(shown, ["b"], True),
    "frozenEmpty": card_plan([], ["a"], True),
    "suffix": short_id("9faed5bb-4c4d-4d0d-afbe-76620f8ee8ec"),
}))
`);
  expect(result.ordered).toEqual(["a", "b", "c"]);
  expect(result.ended).toEqual(["a", "b", "c"]);
  expect(result.free).toEqual(["a", "b", "c"]);
  // While the pointer or the keyboard is in the list, a new session is not added and none is removed.
  expect(result.frozen).toEqual(["a", "b"]);
  expect(result.frozenGone).toEqual(["a", "b"]);
  expect(result.frozenEmpty).toEqual(["a"]);
  expect(result.suffix).toBe("9faed5bb");
});
