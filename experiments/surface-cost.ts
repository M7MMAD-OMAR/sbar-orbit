import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget, readCpuSample } from "../src/resource-budget";
import { cpuInterval } from "../src/cpu-sample";

/**
 * What a larger session surface costs. Sessions can be resized so an application gets room, and the
 * cap on that size has to come from a measurement rather than a guess: every frame is captured and
 * encoded at the chosen size, on a budget of one core shared by everything Orbit owns.
 *
 * One size at a time, one backend at a time. Concurrent bounded commands split the same budget and
 * would report a cost that belongs to the contention, not to the surface.
 */
await requireResourceBudget();
const sizes = [{ width: 1280, height: 800 }, { width: 1600, height: 1000 }, { width: 1920, height: 1080 }, { width: 1920, height: 1200 }];
const frames = 24;
const directory = join("output", `surface-cost-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });

// A page with real content, so encoding is not measuring a blank rectangle.
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  `<!doctype html><title>Surface cost</title><style>body{margin:0;font:16px system-ui;background:linear-gradient(135deg,#f6f7f9,#c8d6ea)}
  .card{display:inline-block;margin:12px;padding:16px;width:280px;background:#fff;border-radius:10px;box-shadow:0 2px 8px #0002}
  h2{margin:0 0 8px;font-size:18px}</style>` +
  Array.from({ length: 40 }, (_, index) =>
    `<div class="card"><h2>Panel ${index + 1}</h2><p>Text, borders and shadows so the encoder has detail to work with rather than flat colour.</p></div>`).join(""),
  { headers: { "Content-Type": "text/html" } }) });

const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), frames, sizes };
const rows: Record<string, unknown>[] = [];
const native = process.env.ORBIT_TEST_NATIVE === "1";
try {
  for (const backend of native ? ["browser", "fedora"] as const : ["browser"] as const) {
    for (const size of sizes) {
      const broker = await startBroker();
      try {
        const session = await call(broker.socket, "session.create", { backend, viewport: size, taskName: `Surface ${size.width}x${size.height}` }) as { sessionId: string };
        const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
        if (backend === "browser") await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });
        else await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), join(directory, `fixture-${size.width}.json`)] });
        await Bun.sleep(1500);

        // Warm the path once so the first encode does not carry allocation cost into the median.
        await call(broker.socket, "session.observe", session);
        const durations: number[] = [];
        let bytes = 0;
        const before = await readCpuSample();
        for (let taken = 0; taken < frames; taken++) {
          const started = performance.now();
          const frame = await call(broker.socket, "session.observe", session) as { image: string; width: number; height: number };
          durations.push(performance.now() - started);
          bytes += Math.round(frame.image.length * 3 / 4);
          if (frame.width !== size.width || frame.height !== size.height) throw new Error("Session reported a size it was not created at");
        }
        const cpu = cpuInterval(before, await readCpuSample());
        durations.sort((a, b) => a - b);
        rows.push({ backend, ...size, pixels: size.width * size.height,
          medianObserveMs: Number(durations[Math.floor(durations.length / 2)]!.toFixed(1)),
          slowestObserveMs: Number(durations.at(-1)!.toFixed(1)),
          medianFrameKiB: Math.round(bytes / frames / 1024),
          // Frames were requested back to back, so this is the cost of a continuous capture loop.
          orbitOneCorePercent: Number(cpu.orbitOneCorePercent.toFixed(1)),
          // What one frame per second, the viewer's default cadence, would cost from that.
          oneFramePerSecondPercent: Number((durations[Math.floor(durations.length / 2)]! / 10).toFixed(1)) });
        console.log(JSON.stringify(rows.at(-1)));
      } finally { await broker.close(); }
    }
  }
  report.rows = rows;
  report.status = "passed";
  report.notes = [
    "Frames were requested back to back with no viewer attached, which is the worst case for capture cost.",
    "oneFramePerSecondPercent projects the median capture onto the viewer's default cadence of one frame per second.",
    native ? "Native rows use one GTK fixture window on the private display." : "Native rows were skipped; set ORBIT_TEST_NATIVE=1 with the Fedora bootstrap in place.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", rows, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  fixture.stop(true);
  console.log(JSON.stringify(report, null, 2));
}
