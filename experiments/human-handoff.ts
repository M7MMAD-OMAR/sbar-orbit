import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget, budgetHeadroom } from "../src/resource-budget";
import { readProcessSet, startFocusMonitor } from "./hyprland-focus";

/**
 * Reuse a broker that is already answering when one is named on `ORBIT_SOCKET`, so the trial can run
 * beside a managed installation on this workstation instead of starting a second broker that the
 * shared slice has no room for. An attached broker is never closed: for this trial it is the one the
 * person is already using. A named socket that does not answer falls through to a private broker.
 */
async function attachOrStartBroker() {
  const existing = process.env.ORBIT_SOCKET;
  if (existing) {
    try { await call(existing, "doctor"); return { socket: existing, attached: true, close: async () => {} }; }
    catch { /* fall through: start a private broker */ }
  }
  const broker = await startBroker();
  return { socket: broker.socket, attached: false, close: () => broker.close() };
}

await requireResourceBudget();
const scope = (await readFile("/proc/self/cgroup", "utf8")).trim().slice(3);
const group = join("/sys/fs/cgroup", scope);
const parent = group.slice(0, group.indexOf("/sbarorbit.slice") + "/sbarorbit.slice".length);
const id = crypto.randomUUID();
const phrase = `orbit-${id.slice(0, 6)}`;
const directory = join("output", `human-handoff-${id}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = { status: "running", automatedDriver: true, humanParticipationConfirmed: false, manualPhraseAccepted: false, pausedObserved: false, resumedAfterManual: false, completedSubmissions: 0,
  // The check table asks for rejected agent input while paused and for work that continues after the
  // viewer is closed. Neither was counted before, so a run could observe a pause and still evidence
  // neither.
  refusedWhilePaused: 0, refusedActionTypes: [] as string[], submissionsAfterResume: 0, sessionStoppedByTrial: false };
let accepted = false, stopping = false, sessionId = "";
const stop = () => { stopping = true; };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method === "POST") {
    const value = await request.text();
    if (value === phrase) accepted = true;
    return new Response(value === phrase ? "Accepted" : "Try the displayed phrase");
  }
  return new Response(`<html><title>Orbit form update demo</title><style>body{font:24px system-ui;padding:32px;background:white;color:#182d45}input,button{font:22px system-ui;padding:12px;margin:8px}section{margin:24px 0;padding:16px;border:1px solid #aaa}</style><h1>Orbit takeover trial</h1><section><h2>Agent work</h2><input id="agent"><button id="agent-save" onclick="document.querySelector('#result').textContent=document.querySelector('#agent').value">Update counter</button><output id="result">Starting</output></section><section><h2>Your turn after Pause</h2><p>Enter <strong>${phrase}</strong>, then click Confirm phrase. Resume afterward.</p><input id="human" placeholder="Test phrase"><button id="human-save" onclick="fetch('/',{method:'POST',body:document.querySelector('#human').value}).then(r=>r.text()).then(t=>document.querySelector('#manual-result').textContent=t)">Confirm phrase</button><output id="manual-result">Waiting</output></section></html>`, { headers: { "Content-Type": "text/html" } });
} });
const broker = await attachOrStartBroker();
report.attachedToExistingBroker = broker.attached;
// The owned set is every process in the shared Orbit slice, descendants included, so a managed
// broker's browser and this trial's own processes both count, whichever broker the session runs on.
// Its size is recorded, because an empty owned set makes every observation read as "nothing was
// owned" and is therefore not evidence of anything.
const focus = await startFocusMonitor(() => readProcessSet(parent));
report.ownedProcesses = (await readProcessSet(parent)).size;
const started = performance.now();
const deadline = started + 600_000;
try {
  const session = await call(broker.socket, "session.create", { backend: "browser", agentName: "SbarOrbit", taskName: "Form updates · scripted demo" }) as { sessionId: string };
  sessionId = session.sessionId;
  const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}` });
  const { url } = await call(broker.socket, "preview.open") as { url: string };
  // The access link is shown once for the participant, never copied into evidence.
  console.log(JSON.stringify({ previewUrl: url, phrase, reportPath: join(directory, "report.json"), sessionId: session.sessionId }));
  let submissions = 0;
  while (!stopping && performance.now() < deadline) {
    const headroom = await budgetHeadroom();
    if (headroom.memory.freeBytes < 512 * 1024 * 1024) throw new Error("Stopped before the shared memory ceiling");
    const sessions = await call(broker.socket, "session.list") as { sessionId: string; state: string }[];
    const state = sessions.find(item => item.sessionId === session.sessionId)?.state;
    if (state === "closed") { report.participantStoppedSession = true; break; }
    if (state === "paused") report.pausedObserved = true;
    report.manualPhraseAccepted = accepted;
    if (state === "running") {
      let attempting = "click #agent";
      try {
        const value = `Agent step ${submissions + 1}`;
        await act({ type: "click", selector: "#agent" });
        await Bun.sleep(250);
        attempting = "fill #agent";
        await act({ type: "fill", selector: "#agent", text: value });
        await Bun.sleep(250);
        attempting = "click #agent-save";
        await act({ type: "click", selector: "#agent-save" });
        attempting = "read #result";
        const result = await act({ type: "read", selector: "#result" }) as { text: string };
        if (result.text !== value) throw new Error("Agent readback mismatch");
        report.completedSubmissions = ++submissions;
        if (accepted && report.pausedObserved) {
          report.resumedAfterManual = true;
          report.submissionsAfterResume = Number(report.submissionsAfterResume) + 1;
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "PAUSED") throw error;
        // The pause refused this action. That refusal, named by what it was, is the evidence the
        // takeover check asks for; before this it was swallowed and the run could not show it.
        report.refusedWhilePaused = Number(report.refusedWhilePaused) + 1;
        (report.refusedActionTypes as string[]).push(attempting);
      }
    }
    report.elapsedSeconds = Math.round((performance.now() - started) / 1000);
    await Bun.write(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await Bun.sleep(500);
  }
  report.status = accepted && report.resumedAfterManual ? "interaction-observed" : "incomplete";
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message : "Trial failed"; process.exitCode = 1; }
finally {
  // The trial stops its own session. Until this it did not, so every run left a browser session
  // running on whatever broker it attached to, and on a managed broker that means somebody else's
  // broker keeps it until the next restart.
  if (sessionId) {
    try { await call(broker.socket, "session.stop", { sessionId }); report.sessionStoppedByTrial = true; }
    catch { /* already closed, by the participant or by the memory ceiling */ }
  }
  await broker.close(); fixture.stop(true);
  report.focus = await focus.stop();
  report.elapsedSeconds = Math.round((performance.now() - started) / 1000);
  report.limitations = ["The driver is scripted, not a model host. A submitted phrase alone does not prove who submitted it.", "Human participation and simultaneous work require explicit participant confirmation.", "The participant's viewer runs in their application outside this measured Orbit scope.", "The owned process set is the whole shared Orbit slice, so it also counts any other agent's sessions running at the same time.", broker.attached ? "The session ran on a broker that was already running, so that broker's own startup and workspace are outside this trial." : "The broker was started by this trial and shares the slice with any other Orbit work."];
  await Bun.write(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.off("SIGTERM", stop); process.off("SIGINT", stop);
  console.log(JSON.stringify({ status: report.status, reportPath: join(directory, "report.json") }));
}
