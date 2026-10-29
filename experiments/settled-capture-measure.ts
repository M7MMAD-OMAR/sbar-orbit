import { startBroker, call } from "../src/ipc";
import { nativeOptionsFromEnv } from "../src/native-worker";

/**
 * Round trips and wall time from "send input" to "a frame I can trust", on a real installed
 * application. Run through scripts/limited.ts with the managed broker's native environment, on a
 * private broker and socket, so no shared broker is restarted.
 *
 *   ORBIT_MEASURE_WORKSPACE=7 ORBIT_MEASURE_MONITOR=HDMI-A-5 ORBIT_MEASURE_APPLICATION=org.gnome.Calculator.desktop \
 *     ORBIT_MEASURE_RUNS=15 \
 *     bun run scripts/limited.ts bun experiments/settled-capture-measure.ts
 *
 * ORBIT_MEASURE_VARIANTS is a comma list; the runs rotate through it, so every variant sees the same
 * machine load. "separate" is text, key, observe (a fourth call when the first frame was stale). Any other
 * name is one act with capture and that settle variant. ORBIT_MEASURE_SCENARIO is calculator (default),
 * editor, dolphin or browser. Frames and timings are written to ORBIT_MEASURE_OUT;
 * settled-capture-analyze.py judges each frame against an observe taken 900 ms later, outside the timing.
 */
const workspace = Number(process.env.ORBIT_MEASURE_WORKSPACE);
let monitor = process.env.ORBIT_MEASURE_MONITOR;
const application = process.env.ORBIT_MEASURE_APPLICATION;
const runs = Number(process.env.ORBIT_MEASURE_RUNS ?? 15);
const variants = (process.env.ORBIT_MEASURE_VARIANTS ?? "separate,classic").split(",");
const scenarioName = process.env.ORBIT_MEASURE_SCENARIO ?? "calculator";
// A local fixture for the browser scenario: typed text is echoed large, Enter paints a list after 80 ms and
// fades a panel in over 250 ms, Escape clears it. Served from localhost only.
const fixture = scenarioName === "browser" ? Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`<!doctype html><meta charset=utf-8><title>settle fixture</title>
<style>body{font:28px sans-serif;margin:24px}input{font:28px sans-serif;width:90%}#echo{font-size:54px;min-height:70px}
#panel{margin-top:16px;padding:12px;background:#fff;transition:background 250ms}#panel.on{background:#bfe3ff}li{font-size:20px}</style>
<input id=i autofocus autocomplete=off><div id=echo></div><div id=panel><ul id=list></ul></div>
<script>const i=document.getElementById("i"),e=document.getElementById("echo"),l=document.getElementById("list"),p=document.getElementById("panel");
i.oninput=()=>{e.textContent=i.value};
i.onkeydown=k=>{if(k.key==="Enter")setTimeout(()=>{l.innerHTML=Array.from({length:14},(_,n)=>"<li>row "+n+" "+i.value+"</li>").join("");p.className="on"},80);
if(k.key==="Escape"){i.value="";e.textContent="";l.innerHTML="";p.className=""}};</script>`, { headers: { "content-type": "text/html" } }) }) : undefined;
const dolphinPaths = ["/usr/share", "/usr/lib64", "/etc", "/usr/bin"];
type Act = (action: object) => Promise<any>;
type Scenario = { reset: (act: Act) => Promise<void>; actions: (run: number) => object[] };
const scenarios: Record<string, Scenario> = {
  calculator: { reset: async act => { await act({ type: "key", key: "Escape" }); }, actions: () => [{ type: "text", text: "12345+6789" }, { type: "key", key: "Return" }] },
  editor: { reset: async act => { await act({ type: "key", key: "ctrl+a" }); await act({ type: "key", key: "BackSpace" }); },
    actions: () => [{ type: "text", text: "The quick brown fox jumps over the lazy dog" }] },
  dolphin: { reset: async () => {}, actions: run => [{ type: "key", key: "ctrl+l" }, { type: "text", text: dolphinPaths[run % dolphinPaths.length]! }, { type: "key", key: "Return" }] },
  // A real read-only page, scrolled down and up; the window is browsed, never logged in.
  site: { reset: async () => {}, actions: run => [{ type: "scroll", x: 400, y: 400, dy: run % 2 === 0 ? 12 : -12 }] },
  browser: { reset: async act => { await act({ type: "key", key: "Escape" }); }, actions: () => [{ type: "text", text: "orbit settle" }, { type: "key", key: "Return" }] },
};
const scenario = scenarios[scenarioName];
if (!scenario) throw new Error("Unknown ORBIT_MEASURE_SCENARIO " + scenarioName);
if (!workspace || !monitor) throw new Error("Set ORBIT_MEASURE_WORKSPACE and ORBIT_MEASURE_MONITOR");
const broker = await startBroker({ native: nativeOptionsFromEnv() });
const rpc = (method: string, params: unknown = {}) => call(broker.socket, method, params) as Promise<any>;
// The owner's focus decides when an output is unfocused. Retry the same request identity until it is.
async function present(workspace: number) {
  let requestId = crypto.randomUUID(), asked = monitor;
  for (let attempt = 0; attempt < 90; attempt++) {
    // The owner moves between outputs; ORBIT_MEASURE_MONITOR=auto takes whichever is not focused right now.
    if (process.env.ORBIT_MEASURE_MONITOR === "auto")
      monitor = (await rpc("native.monitors")).monitors.find((entry: { focused: boolean }) => !entry.focused)?.name ?? monitor;
    // A refusal is remembered per request; a different output is a different request.
    if (monitor !== asked) { requestId = crypto.randomUUID(); asked = monitor; }
    try { return await rpc("native.present", { requestId, workspace, monitor }); }
    catch (error) { if ((error as { code?: string }).code !== "PRESENTATION_NOT_READY") throw error; if (attempt % 10 === 0) console.error("present refused:", monitor, (error as Error).message); await Bun.sleep(2000); }
  }
  throw new Error("The output stayed focused; try again when the owner is elsewhere");
}
let sessionId: string | undefined, target: { appId: string; windowId: string } | undefined;
const monitorsNow = (await rpc("native.monitors")).monitors as { name: string; workspace: number; focused: boolean }[];
if (monitor === "auto") monitor = monitorsNow.find(entry => !entry.focused)?.name;
const previous = monitorsNow.map(entry => ({ monitor: entry.name, workspace: entry.workspace }));
try {
  // A workspace that is already displayed needs no presentation; the owner's focus may forbid one.
  if (process.env.ORBIT_MEASURE_PRESENT !== "0") await present(workspace);
  const opened = application ? await rpc("native.open", { requestId: crypto.randomUUID(), workspace, applicationId: application }) : undefined;
  // An owner-focused new window comes back candidate-only; it is still the window this run launched.
  const launched = opened && (opened.opened === true ? opened : opened.candidate);
  if (opened && !launched) throw new Error("Application did not open as a new window: " + JSON.stringify(opened));
  const candidates = opened ? undefined : await rpc("native.candidates", { workspace });
  const candidate = launched ?? candidates.candidates?.[0] ?? candidates.windows?.[0];
  if (!candidate) throw new Error("No candidate window: " + JSON.stringify(candidates).slice(0, 400));
  const session = await rpc("session.create", { backend: "native", taskName: "Settled capture measurement",
    handoff: { workspace, address: candidate.address, stableId: candidate.stableId } });
  sessionId = session.sessionId;
  const appId = session.handoff.appId;
  const listed = await rpc("session.act", { sessionId, requestId: crypto.randomUUID(), action: { type: "windows", appId } });
  target = { appId, windowId: listed.windows[0].windowId };
  const goal = target;
  const act = (action: object) => rpc("session.act", { sessionId, requestId: crypto.randomUUID(), action: { ...goal, ...action } });
  const observe = () => rpc("session.observe", { sessionId, ...goal });
  const settle = async () => { await scenario.reset(act); await Bun.sleep(250); };
  await Bun.sleep(1500); // a new window is still resizing for a moment after it opens
  const address = fixture ? `http://localhost:${fixture.port}/` : scenarioName === "site" ? process.env.ORBIT_MEASURE_URL : undefined;
  if (address) {
    for (const step of [{ type: "key", key: "ctrl+l" }, { type: "text", text: address }, { type: "key", key: "Return" }]) await act(step);
    await Bun.sleep(scenarioName === "site" ? 8000 : 3000);
  }
  const out = process.env.ORBIT_MEASURE_OUT;
  if (!out) throw new Error("Set ORBIT_MEASURE_OUT to an empty directory for frames and timings");
  // Window geometry next to the frame size: image pixels and input coordinates must share one origin.
  await Bun.write(`${out}/state.json`, JSON.stringify({ state: await act({ type: "state" }), first: (({ image: _image, ...rest }) => rest)(await observe()) }));
  const rows: object[] = [];
  for (let run = 0; run < runs * variants.length; run++) {
    await settle();
    const mode = variants[run % variants.length]!;
    const started = performance.now();
    let frame: { image: string }, calls: number, settleReport: unknown = null;
    if (mode === "separate") {
      for (const action of scenario.actions(run)) await act(action);
      frame = await observe(); calls = scenario.actions(run).length + 1;
    } else {
      const result = await rpc("session.act", { sessionId, requestId: crypto.randomUUID(),
        actions: scenario.actions(run).map(action => ({ ...action, ...goal })), capture: { variant: mode } });
      if (!result.ok) throw new Error("Batch failed: " + JSON.stringify(result.receipts));
      frame = result.capture; calls = 1; settleReport = result.capture.settle;
    }
    const ms = performance.now() - started;
    await Bun.sleep(900);
    const final = await observe();
    const again = performance.now();
    await observe(); // what a stale first frame costs the agent: one more observe
    const extra = performance.now() - again;
    await Bun.write(`${out}/${mode}-${run}.png`, Buffer.from(frame.image, "base64"));
    await Bun.write(`${out}/final-${run}.png`, Buffer.from(final.image, "base64"));
    rows.push({ run, mode, calls, ms: Math.round(ms), extraObserveMs: Math.round(extra), settle: settleReport });
  }
  await settle();
  await Bun.write(`${out}/runs.json`, JSON.stringify(rows));
  console.log(`Wrote ${rows.length} runs to ${out}; run experiments/settled-capture-analyze.py on it.`);
} catch (error) {
  console.error("Measurement failed:", error);
  process.exitCode = 1;
} finally {
  // Only a window this run opened is closed; an application that was already there is left alone.
  if (sessionId && application && target) await rpc("session.act", { sessionId, requestId: crypto.randomUUID(), action: { type: "close-window", ...target } }).catch(() => {});
  if (sessionId) await rpc("session.stop", { sessionId }).catch(() => {});
  // Every output goes back to the workspace it showed, whichever one this run presented on.
  if (process.env.ORBIT_MEASURE_PRESENT !== "0") for (const before of previous) {
    process.env.ORBIT_MEASURE_MONITOR = monitor = before.monitor;
    await present(before.workspace).catch(() => {});
  }
  fixture?.stop(true);
  process.exit(process.exitCode ?? 0);
}
