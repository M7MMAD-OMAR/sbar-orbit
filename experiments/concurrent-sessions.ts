import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget, readCpuSample } from "../src/resource-budget";
import { cpuInterval } from "../src/cpu-sample";

/**
 * Several agents on one broker at once. Each session is driven by its own independent loop, the way
 * separate agents would drive them, with no coordination between loops. The question is whether
 * every session finishes its own work correctly while the others run, and what that costs on the
 * shared one-core budget.
 *
 * Browser sessions each read a heading, fill a field and check the page echoed it back, across two
 * tabs. Native sessions each launch a GTK fixture, paste a phrase and confirm the fixture saved it.
 */
await requireResourceBudget();
const browsers = Number(process.env.ORBIT_CONCURRENT_BROWSERS ?? 3);
const natives = process.env.ORBIT_TEST_NATIVE === "1" ? Number(process.env.ORBIT_CONCURRENT_NATIVES ?? 2) : 0;
const rounds = Number(process.env.ORBIT_CONCURRENT_ROUNDS ?? 4);
const directory = join("output", `concurrent-sessions-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const root = await mkdtemp("/tmp/orbit-concurrent-");

const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  const who = url.searchParams.get("who") ?? "nobody";
  return new Response(`<!doctype html><title>Desk ${who}</title><style>body{font:18px system-ui;padding:32px;background:#f3f5f8}</style>
    <h1 id="who">Desk ${who}</h1><input id="note" aria-label="note"><button id="save" onclick="document.querySelector('#echo').textContent=document.querySelector('#note').value">Save</button>
    <output id="echo">empty</output><p><a id="more" href="/more?who=${who}" target="_blank">More</a></p>`, { headers: { "Content-Type": "text/html" } });
} });

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), browsers, natives, rounds };
const errors: string[] = [];
// Outcomes live outside the per-session functions, so rounds a session finished before it failed
// are still counted rather than lost with the thrown error.
const outcomes = new Map<string, unknown[]>();
try {
  const before = await readCpuSample();
  const startedAt = performance.now();

  const browserWork = async (index: number) => {
    const name = `browser-${index + 1}`;
    const session = await call(broker.socket, "session.create", { backend: "browser", agentName: `Agent ${index + 1}`, taskName: name }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const mine: unknown[] = [];
    outcomes.set(name, mine);
    try {
      await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/?who=${name}` });
      for (let round = 0; round < rounds; round++) {
        const phrase = `${name} round ${round + 1}`;
        const t = performance.now();
        await act({ type: "fill", selector: "#note", text: phrase });
        await act({ type: "click", selector: "#save" });
        const echoed = await act({ type: "read", selector: "#echo" }) as { text: string };
        const heading = await act({ type: "read", selector: "#who" }) as { text: string };
        // A second tab, then back, so tab following is exercised under load too.
        await act({ type: "click", selector: "#more" });
        const frame = await call(broker.socket, "session.observe", session) as { presence: { pageCount: number; pageIndex: number } };
        await act({ type: "select-tab", tab: 1 });
        const after = await act({ type: "read", selector: "#echo" }) as { text: string };
        const ok = echoed.text === phrase && heading.text === `Desk ${name}` && after.text === phrase && frame.presence.pageCount >= 2;
        if (!ok) errors.push(`${name} round ${round + 1}: ${JSON.stringify({ echoed, heading, after, presence: frame.presence })}`);
        mine.push({ round: round + 1, ok, ms: Math.round(performance.now() - t), tabs: frame.presence.pageCount });
        if (frame.presence.pageCount > 1) await act({ type: "close-tab", tab: frame.presence.pageCount });
      }
    } finally { await call(broker.socket, "session.stop", session).catch(() => {}); }
    return { name, outcomes: mine };
  };

  const nativeWork = async (index: number) => {
    const name = `native-${index + 1}`;
    const session = await call(broker.socket, "session.create", { backend: "fedora", agentName: `Agent N${index + 1}`, taskName: name }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const mine: unknown[] = [];
    outcomes.set(name, mine);
    try {
      const file = join(root, `${name}.json`);
      await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), file] });
      for (let round = 0; round < rounds; round++) {
        const phrase = `${name} جولة ${round + 1}`;
        const t = performance.now();
        await act({ type: "pointer", x: 280, y: 184 });
        await act({ type: "key", key: "Ctrl+A" });
        await act({ type: "paste", text: phrase });
        // Paste is acknowledged when the shortcut is delivered, not when the application has read
        // the clipboard, so the next click waits for the text to show, as the tool contract says.
        let saved: { text?: string; saved?: string | null } = {};
        for (let i = 0; i < 60; i++) {
          try { saved = JSON.parse(await Bun.file(file).text()); if (saved.text === phrase) break; } catch {}
          await Bun.sleep(100);
        }
        // The fixture's save button, so the round proves a click landed as well as a paste.
        await act({ type: "pointer", x: 590, y: 184 });
        for (let i = 0; i < 60; i++) {
          try { saved = JSON.parse(await Bun.file(file).text()); if (saved.saved === phrase) break; } catch {}
          await Bun.sleep(100);
        }
        const frame = await call(broker.socket, "session.observe", session) as { presence: { pageCount: number; title: string } };
        const ok = saved.saved === phrase;
        if (!ok) errors.push(`${name} round ${round + 1}: ${JSON.stringify(saved)}`);
        mine.push({ round: round + 1, ok, ms: Math.round(performance.now() - t), windows: frame.presence.pageCount, title: frame.presence.title });
      }
    } finally { await call(broker.socket, "session.stop", session).catch(() => {}); }
    return { name, outcomes: mine };
  };

  const results = await Promise.allSettled([
    ...Array.from({ length: browsers }, (_, i) => browserWork(i)),
    ...Array.from({ length: natives }, (_, i) => nativeWork(i)),
  ]);
  const cpu = cpuInterval(before, await readCpuSample());
  report.elapsedMs = Math.round(performance.now() - startedAt);
  const names = [...Array.from({ length: browsers }, (_, i) => `browser-${i + 1}`), ...Array.from({ length: natives }, (_, i) => `native-${i + 1}`)];
  report.sessions = results.map((result, index) => result.status === "fulfilled" ? result.value
    : { name: names[index], failed: true, message: result.reason instanceof Error ? result.reason.message : String(result.reason), code: (result.reason as { code?: string })?.code, outcomes: outcomes.get(names[index]!) ?? [] });
  report.cpu = { orbitOneCorePercent: Number(cpu.orbitOneCorePercent.toFixed(1)), orbitMachinePercent: Number(cpu.orbitMachinePercent.toFixed(2)), hostBusyPercent: Number(cpu.hostBusyPercent.toFixed(1)) };
  const all = [...outcomes.values()].flat() as { ok: boolean; ms: number }[];
  report.totals = { rounds: all.length, passed: all.filter(o => o.ok).length, failedRounds: all.filter(o => !o.ok).length,
    sessionsFailed: results.filter(r => r.status === "rejected").length,
    medianRoundMs: all.length ? [...all].sort((a, b) => a.ms - b.ms)[Math.floor(all.length / 2)]!.ms : null };
  report.errors = errors;
  report.status = !all.length || errors.length || results.some(r => r.status === "rejected") ? "failed" : "passed";
  report.notes = [
    "Every session runs its own loop with no coordination, so this is contention, not a benchmark of one session.",
    "CPU is the whole shared budget over the whole run, including session creation and teardown.",
    natives ? "Native sessions paste Arabic through their private clipboards concurrently." : "Native sessions were skipped; set ORBIT_TEST_NATIVE=1.",
  ];
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
  fixture.stop(true);
}
if (report.status !== "passed") process.exitCode = 1;
