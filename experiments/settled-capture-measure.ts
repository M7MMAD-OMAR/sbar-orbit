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
 * Separate: text, key, observe (a fourth call when the first frame was stale). Batched: one act with
 * capture. Frames and timings are written to ORBIT_MEASURE_OUT; settled-capture-analyze.py judges each
 * frame against an observe taken 900 ms later, outside the timing.
 */
const workspace = Number(process.env.ORBIT_MEASURE_WORKSPACE), monitor = process.env.ORBIT_MEASURE_MONITOR;
const application = process.env.ORBIT_MEASURE_APPLICATION;
const runs = Number(process.env.ORBIT_MEASURE_RUNS ?? 15);
if (!workspace || !monitor) throw new Error("Set ORBIT_MEASURE_WORKSPACE and ORBIT_MEASURE_MONITOR");
const broker = await startBroker({ native: nativeOptionsFromEnv() });
const rpc = (method: string, params: unknown = {}) => call(broker.socket, method, params) as Promise<any>;
// The owner's focus decides when an output is unfocused. Retry the same request identity until it is.
async function present(workspace: number) {
  const requestId = crypto.randomUUID();
  for (let attempt = 0; attempt < 90; attempt++) {
    try { return await rpc("native.present", { requestId, workspace, monitor }); }
    catch (error) { if ((error as { code?: string }).code !== "PRESENTATION_NOT_READY") throw error; await Bun.sleep(2000); }
  }
  throw new Error("The output stayed focused; try again when the owner is elsewhere");
}
let sessionId: string | undefined, target: { appId: string; windowId: string } | undefined;
const previous = (await rpc("native.monitors")).monitors.find((entry: { name: string }) => entry.name === monitor)?.workspace as number | undefined;
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
  const settle = async () => { await act({ type: "key", key: "Escape" }); await Bun.sleep(250); };
  await Bun.sleep(1500); // a new window is still resizing for a moment after it opens
  const out = process.env.ORBIT_MEASURE_OUT;
  if (!out) throw new Error("Set ORBIT_MEASURE_OUT to an empty directory for frames and timings");
  const rows: object[] = [];
  for (let run = 0; run < runs * 2; run++) {
    await settle();
    const mode = run % 2 === 0 ? "separate" : "batched";
    const started = performance.now();
    let frame: { image: string }, calls: number, settleReport: unknown = null;
    if (mode === "separate") {
      await act({ type: "text", text: "12345+6789" });
      await act({ type: "key", key: "Return" });
      frame = await observe(); calls = 3;
    } else {
      const result = await rpc("session.act", { sessionId, requestId: crypto.randomUUID(),
        actions: [{ type: "text", ...goal, text: "12345+6789" }, { type: "key", ...goal, key: "Return" }], capture: {} });
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
  if (previous !== undefined && process.env.ORBIT_MEASURE_PRESENT !== "0") await present(previous).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
