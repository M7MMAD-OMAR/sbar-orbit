import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";
import { startFocusMonitor } from "./hyprland-focus";

await requireResourceBudget();
const scope = (await readFile("/proc/self/cgroup", "utf8")).trim().slice(3);
const group = join("/sys/fs/cgroup", scope);
const parent = group.slice(0, group.indexOf("/sbarorbit.slice") + "/sbarorbit.slice".length);
const id = crypto.randomUUID();
const phrase = `orbit-${id.slice(0, 6)}`;
const directory = join("output", `human-handoff-${id}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = { status: "running", automatedDriver: true, humanParticipationConfirmed: false, manualPhraseAccepted: false, pausedObserved: false, resumedAfterManual: false, completedSubmissions: 0 };
let accepted = false, stopping = false;
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
const broker = await startBroker();
const focus = await startFocusMonitor(async () => new Set((await readFile(join(group, "cgroup.procs"), "utf8")).trim().split(/\s+/).map(Number)));
const started = performance.now();
const deadline = started + 600_000;
try {
  const session = await call(broker.socket, "session.create", { backend: "browser", agentName: "SbarOrbit", taskName: "Form updates · scripted demo" }) as { sessionId: string };
  const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}` });
  const { url } = await call(broker.socket, "preview.open") as { url: string };
  // The access link is shown once for the participant, never copied into evidence.
  console.log(JSON.stringify({ previewUrl: url, phrase, reportPath: join(directory, "report.json"), sessionId: session.sessionId }));
  let submissions = 0;
  while (!stopping && performance.now() < deadline) {
    if (Number(await readFile(join(parent, "memory.current"), "utf8")) > 1900 * 1024 * 1024) throw new Error("Stopped before hard memory limit");
    const sessions = await call(broker.socket, "session.list") as { sessionId: string; state: string }[];
    const state = sessions.find(item => item.sessionId === session.sessionId)?.state;
    if (state === "closed") { report.participantStoppedSession = true; break; }
    if (state === "paused") report.pausedObserved = true;
    report.manualPhraseAccepted = accepted;
    if (state === "running") {
      try {
        const value = `Agent step ${submissions + 1}`;
        await act({ type: "click", selector: "#agent" });
        await Bun.sleep(250);
        await act({ type: "fill", selector: "#agent", text: value });
        await Bun.sleep(250);
        await act({ type: "click", selector: "#agent-save" });
        const result = await act({ type: "read", selector: "#result" }) as { text: string };
        if (result.text !== value) throw new Error("Agent readback mismatch");
        report.completedSubmissions = ++submissions;
        if (accepted && report.pausedObserved) report.resumedAfterManual = true;
      } catch (error) { if ((error as { code?: string }).code !== "PAUSED") throw error; }
    }
    report.elapsedSeconds = Math.round((performance.now() - started) / 1000);
    await Bun.write(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await Bun.sleep(500);
  }
  report.status = accepted && report.resumedAfterManual ? "interaction-observed" : "incomplete";
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message : "Trial failed"; process.exitCode = 1; }
finally {
  await broker.close(); fixture.stop(true);
  report.focus = await focus.stop();
  report.elapsedSeconds = Math.round((performance.now() - started) / 1000);
  report.limitations = ["The driver is scripted, not a model host. A submitted phrase alone does not prove who submitted it.", "Human participation and simultaneous work require explicit participant confirmation.", "The participant's viewer runs in their application outside this measured Orbit scope."];
  await Bun.write(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.off("SIGTERM", stop); process.off("SIGINT", stop);
  console.log(JSON.stringify({ status: report.status, reportPath: join(directory, "report.json") }));
}
