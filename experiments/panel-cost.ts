import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * What the desktop panel costs while it watches. The panel polls the broker once a second for the
 * session list and one presence read per session; the question the person asked is whether that, or
 * the pill and its blink, is what drives the processor. The panel is launched into a private display
 * beside a few sessions so it has real work to poll, its own CPU is sampled from the pid its launcher
 * wrote over a fixed window, and the broker's CPU over the same window is sampled too. Neither is the
 * agents' own work: this measures only the watching, not the sessions.
 */
await requireResourceBudget();
const directory = join("output", `panel-cost-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const sessionCount = Number(process.env.ORBIT_PANEL_COST_SESSIONS ?? 3);
const windowSeconds = Number(process.env.ORBIT_PANEL_COST_SECONDS ?? 20);
const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), sessionCount, windowSeconds };

const ticks = async (pid: number) => {
  const stat = await Bun.file(`/proc/${pid}/stat`).text();
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
};
const clockTck = Number((await Bun.$`getconf CLK_TCK`.text()).trim()) || 100;

try {
  const display = await call(broker.socket, "session.create", { backend: "fedora", agentName: "Panel", taskName: "Cost", viewport: { width: 1280, height: 800 } }) as { sessionId: string };
  const act = (a: unknown) => call(broker.socket, "session.act", { sessionId: display.sessionId, requestId: crypto.randomUUID(), action: a });
  // Extra browser sessions, so the panel has more than one presence to read each second.
  for (let i = 0; i < sessionCount; i++) {
    await call(broker.socket, "session.create", { backend: "browser", agentName: `Agent ${i + 1}`, taskName: `Task ${i + 1}` });
  }
  const panelPidFile = join(directory, "panel.pid");
  await act({ type: "launch", toolkit: "wayland", argv: ["/bin/sh", "-c",
    `ORBIT_SOCKET=${JSON.stringify(broker.socket)} /usr/bin/python3 ${JSON.stringify(resolve("desktop/panel.py"))} >${JSON.stringify(join(directory, "panel.log"))} 2>&1 & echo $! >${JSON.stringify(panelPidFile)}; exec /usr/bin/gnome-calculator`] });
  await Bun.sleep(2500);
  const panelPid = Number((await Bun.file(panelPidFile).text()).trim());
  if (!Number.isInteger(panelPid)) throw new Error("panel pid not written");

  const brokerPid = process.pid;
  const p0 = await ticks(panelPid), b0 = await ticks(brokerPid), t0 = performance.now();
  await Bun.sleep(windowSeconds * 1000);
  const p1 = await ticks(panelPid), b1 = await ticks(brokerPid), t1 = performance.now();
  const elapsed = (t1 - t0) / 1000;
  const rss = Number((await Bun.file(`/proc/${panelPid}/status`).text()).match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);

  report.panel = {
    oneCorePercent: Number((100 * (p1 - p0) / clockTck / elapsed).toFixed(2)),
    cpuTicks: p1 - p0, rssKiB: rss,
  };
  report.broker = { oneCorePercent: Number((100 * (b1 - b0) / clockTck / elapsed).toFixed(2)), cpuTicks: b1 - b0 };
  report.notes = [
    `Panel polled ${sessionCount + 1} sessions once a second for ${windowSeconds} seconds.`,
    "CPU is a share of one core; the broker figure is only the cost of answering the panel's polls, not the sessions.",
    "The pill's blink and colour transitions are CSS on the Cairo renderer and repaint a widget of a few pixels.",
  ];
  report.status = "measured";
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
}
if (report.status !== "measured") process.exitCode = 1;
