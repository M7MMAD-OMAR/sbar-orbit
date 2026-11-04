import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
import { resolve } from "node:path";

const test = linuxOnlySuite("display-free panel status method fixtures");
async function python(code: string) {
  const child = Bun.spawn(["/usr/bin/python3", "-c", code], { env: { ...process.env, PYTHONPATH: resolve("desktop") }, stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error("Panel method fixture failed: " + err.trim());
  return JSON.parse(out);
}

// Compile only selected real Panel methods, without importing GTK, starting the panel or drawing.
const harness = `
import ast, json
from pathlib import Path
from types import SimpleNamespace
from panel_broker import (BrokerError, normalize_read_views, read_owner_view_status, read_sessions,
                          read_view_summary, session_shape, unavailable_read_views)
source = ast.parse(Path("desktop/panel.py").read_text())
panel = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == "Panel")
methods = [node for node in panel.body if isinstance(node, ast.FunctionDef) and node.name in
           ("poll_loop", "apply_status", "refresh_read_view_status", "set_expanded")]
queued = []
GLib = SimpleNamespace(get_monotonic_time=lambda: 0, idle_add=lambda *args: queued.append(args))
PRESENCE_WHILE_COLLAPSED_S = 10
namespace = globals()
exec(compile(ast.Module(body=methods, type_ignores=[]), "panel-method-fixture", "exec"), namespace)
class Label:
    def __init__(self): self.value, self.changes = read_view_summary(None), []
    def get_label(self): return self.value
    def set_label(self, value): self.value = value; self.changes.append(value)
active = {"available": True, "enabled": True, "activeChannels": 1, "readViews": 2}
`;

test("existing poll reads owner metadata only while expanded and old broker failure cannot break sessions", async () => {
  const result = await python(harness + `
class Client:
    def __init__(self, fail_status=False, offline=False): self.calls, self.fail_status, self.offline = [], fail_status, offline
    def call(self, method, params=None):
        self.calls.append(method)
        if method == "session.list":
            if self.offline: raise OSError("private-offline")
            return [{"sessionId": "a", "state": "running"}]
        if method == "session.presence": return {"title": "unchanged"}
        if method == "views.owner-status":
            if self.fail_status: raise BrokerError("private-error", "UNSUPPORTED")
            return active
        raise AssertionError("No capture or mutation")
    def close(self): pass
results = []
for expanded, fail_status, offline in [(False, False, False), (True, False, False), (True, True, False), (True, False, True)]:
    queued.clear()
    client = Client(fail_status, offline)
    model = SimpleNamespace(stopping=False, expanded=expanded, presence_due=1000, read_views_generation=7,
                            detail_id=None, client=client, sessions=[], interval=lambda: 0.5, apply_status=lambda *args: None)
    class Wake:
        def wait(self, timeout): model.stopping = True
        def clear(self): pass
    model.wake = Wake()
    poll_loop(model)
    result = queued[0]
    results.append({"calls": client.calls, "reachable": result[2], "status": result[-2], "generation": result[-1]})
print(json.dumps(results))
`);
  expect(result[0]).toEqual({ calls: ["session.list"], reachable: true, status: { available: false, enabled: false, activeChannels: 0, readViews: 0 }, generation: 7 });
  expect(result[1].calls).toEqual(["session.list", "session.presence", "views.owner-status"]);
  expect(result[1].status).toEqual({ available: true, enabled: true, activeChannels: 1, readViews: 2 });
  expect(result[2].reachable).toBe(true); expect(result[2].status.available).toBe(false);
  expect(result[3].calls).toEqual(["session.list"]); expect(result[3].reachable).toBe(false);
});

test("real apply method updates only fixed status text and never keeps active metadata offline", async () => {
  const result = await python(harness + `
label, events = Label(), []
model = SimpleNamespace(expanded=True, read_views_generation=3, language="en", read_view_status_label=label,
                        detail_id=None, journal=[], last_shape=None, render=lambda: events.append("render"),
                        announce=lambda: events.append("announce"), refresh_views=lambda: events.append("refresh"))
model.refresh_read_view_status = lambda: refresh_read_view_status(model)
apply_status(model, [], True, [], None, active, 3)
apply_status(model, [], True, [], None, {**active, "activeChannels": 2, "readViews": 3}, 3)
after_metadata = list(events)
apply_status(model, [], False, [], None, active, 3)
print(json.dumps({"changes": label.changes, "metadataEvents": after_metadata, "offline": model.read_views}))
`);
  expect(result.changes).toEqual(["Multi-view reads: Active: 1 channels, 2 views", "Multi-view reads: Active: 2 channels, 3 views", "Multi-view reads: Not available"]);
  expect(result.metadataEvents).toEqual(["render", "announce", "refresh"]);
  expect(result.offline).toEqual({ available: false, enabled: false, activeChannels: 0, readViews: 0 });
});

test("collapse and reopen discard queued old active metadata while waking only the existing poll", async () => {
  const result = await python(harness + `
label, events = Label(), []
model = SimpleNamespace(expanded=True, cards_stale=False, drag=None, read_views_generation=1, read_views=dict(active),
                        language="en", read_view_status_label=label, confirming=None, detail_id=None, journal=[], last_shape=None,
                        fill_cards=lambda: events.append("fill"), show_list=lambda **kw: events.append("list"),
                        wake=SimpleNamespace(set=lambda: events.append("wake")), shell=SimpleNamespace(morph=lambda value: events.append("morph")),
                        settle=lambda: None, render=lambda: None, announce=lambda: None, refresh_views=lambda: None)
model.refresh_read_view_status = lambda: refresh_read_view_status(model)
set_expanded(model, False)
set_expanded(model, True)
apply_status(model, [], True, [], None, active, 1)
stale = dict(model.read_views)
apply_status(model, [], True, [], None, active, model.read_views_generation)
print(json.dumps({"stale": stale, "fresh": model.read_views, "generation": model.read_views_generation, "events": events}))
`);
  expect(result.stale.available).toBe(false); expect(result.fresh.available).toBe(true);
  expect(result.generation).toBe(3); expect(result.events).toEqual(["list", "morph", "fill", "wake", "morph"]);
});

test("status UI is a read-only label and adds no poll timers threads or capture calls", async () => {
  const result = await python(harness + `
assignments = [node for node in ast.walk(panel) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Attribute)
               and target.attr == "read_view_status_label" for target in node.targets)]
constructor = assignments[0].value
summary = next(keyword.value for keyword in constructor.keywords if keyword.arg == "label")
label_calls = [node.func.attr for node in ast.walk(panel) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
               and isinstance(node.func.value, ast.Attribute) and node.func.value.attr == "read_view_status_label"]
poll = next(node for node in methods if node.name == "poll_loop")
poll_calls = [node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
              for node in ast.walk(poll) if isinstance(node, ast.Call)]
print(json.dumps({"constructors": len(assignments), "widget": constructor.func.attr, "summary": summary.func.id,
                  "interactive": "connect" in label_calls, "extraTimers": any(name in ("timeout_add", "Thread", "Popen", "observe", "capture") for name in poll_calls)}))
`);
  expect(result).toEqual({ constructors: 1, widget: "Label", summary: "read_view_summary", interactive: false, extraTimers: false });
});
