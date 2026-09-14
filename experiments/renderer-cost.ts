import { mkdir, readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, call } from "../src/ipc";
import { requireResourceBudget, readCpuSample } from "../src/resource-budget";
import { cpuInterval } from "../src/cpu-sample";

/**
 * G3 and G4 in docs/porting.md: is the GPU renderer cheaper than pixman at Orbit's sizes, does
 * sharing a GPU with the person's compositor cost their desktop anything, and does the GPU path fix
 * an Electron window that takes over ten seconds to map under software rendering.
 *
 * One renderer at a time, one size at a time, the same capture loop for each. The GPU is the
 * integrated one, chosen by boot_vga rather than by vendor id, and pinned through the same opt in a
 * broker would use: ORBIT_NATIVE_RENDERER and ORBIT_NATIVE_RENDER_DEVICE. The person's compositor is
 * read from /proc for the same interval, which is the only way to see whether Orbit's frames cost
 * their desktop anything, and it is read idle first so the loop has a baseline to be compared with.
 */
await requireResourceBudget();
const sizes = [{ width: 1280, height: 800 }, { width: 1920, height: 1200 }];
const frames = 24;
const date = new Date().toISOString().slice(0, 10);
const directory = join("output", `renderer-cost-${date}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const ticksPerSecond = 100;

async function integratedRenderNode() {
  for (const node of (await readdir("/sys/class/drm")).filter(name => /^renderD\d+$/.test(name)).sort()) {
    const bootVga = (await readFile(`/sys/class/drm/${node}/device/boot_vga`, "utf8").catch(() => "")).trim();
    if (bootVga === "1") return { device: `/dev/dri/${node}`, vendor: (await readFile(`/sys/class/drm/${node}/device/vendor`, "utf8")).trim() };
  }
  return null;
}
async function processTicks(pid: number) {
  // No catch: a process that vanished mid run is a failed measurement, not zero ticks.
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11] ?? 0) + Number(fields[12] ?? 0));
}
const desktopPid = Number((await Bun.$`pidof Hyprland`.text().catch(() => "")).trim().split(" ")[0]) || undefined;
const integrated = await integratedRenderNode();
const report: Record<string, unknown> = { date, frames, sizes, integrated, desktopCompositor: desktopPid ? "Hyprland" : "not found" };
const rows: Record<string, unknown>[] = [];
const mapping: Record<string, unknown>[] = [];

// The person's compositor at rest, over the same length of interval the capture loops take, so the
// loop figures below have something to be compared with.
const idleSeconds = 8;
const idleBefore = desktopPid ? await processTicks(desktopPid) : 0;
await Bun.sleep(idleSeconds * 1000);
const desktopIdlePercent = desktopPid ? ((await processTicks(desktopPid)) - idleBefore) / ticksPerSecond / idleSeconds * 100 : null;
report.desktopIdlePercent = desktopIdlePercent === null ? null : Number(desktopIdlePercent.toFixed(1));

const renderers: { label: string; env: Record<string, string> }[] = [{ label: "pixman", env: { ORBIT_NATIVE_RENDERER: "pixman" } }];
if (integrated) renderers.push({ label: `gles2 on ${integrated.device}`, env: { ORBIT_NATIVE_RENDERER: "gles2", ORBIT_NATIVE_RENDER_DEVICE: integrated.device } });

try {
  for (const renderer of renderers) {
    for (const key of ["ORBIT_NATIVE_RENDERER", "ORBIT_NATIVE_RENDER_DEVICE"]) delete process.env[key];
    Object.assign(process.env, renderer.env);
    for (const size of sizes) {
      const broker = await startBroker();
      try {
        const session = await call(broker.socket, "session.create", { backend: "fedora", viewport: size, taskName: `Renderer ${renderer.label} ${size.width}x${size.height}` }) as { sessionId: string; renderer?: { asked: string; bound: string; device?: string }; compositorPid?: number };
        const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
        await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), join(directory, `fixture-${renderer.label.split(" ")[0]}-${size.width}.json`)] });
        await Bun.sleep(1500);
        const sway = session.compositorPid;
        await call(broker.socket, "session.observe", session);
        const durations: number[] = [];
        const before = await readCpuSample();
        const swayBefore = sway ? await processTicks(sway) : 0;
        const desktopBefore = desktopPid ? await processTicks(desktopPid) : 0;
        const started = performance.now();
        for (let taken = 0; taken < frames; taken++) {
          const at = performance.now();
          const frame = await call(broker.socket, "session.observe", session) as { image: string; width: number; height: number };
          durations.push(performance.now() - at);
          if (frame.width !== size.width || frame.height !== size.height) throw new Error("Session reported a size it was not created at");
          if (taken === frames - 1) await Bun.write(join(directory, `frame-${renderer.label.split(" ")[0]}-${size.width}.jpg`), Buffer.from(frame.image, "base64"));
        }
        const seconds = (performance.now() - started) / 1000;
        const cpu = cpuInterval(before, await readCpuSample());
        const swayMs = sway ? ((await processTicks(sway)) - swayBefore) * (1000 / ticksPerSecond) : null;
        const desktopPercent = desktopPid ? ((await processTicks(desktopPid)) - desktopBefore) / ticksPerSecond / seconds * 100 : null;
        durations.sort((a, b) => a - b);
        rows.push({ renderer: renderer.label, rendererBound: session.renderer?.bound, ...size,
          medianObserveMs: Number(durations[Math.floor(durations.length / 2)]!.toFixed(1)),
          slowestObserveMs: Number(durations.at(-1)!.toFixed(1)),
          compositorMsPerFrame: swayMs === null ? null : Number((swayMs / frames).toFixed(1)),
          orbitOneCorePercent: Number(cpu.orbitOneCorePercent.toFixed(1)),
          desktopCompositorPercent: desktopPercent === null ? null : Number(desktopPercent.toFixed(1)) });
        console.log(JSON.stringify(rows.at(-1)));
        // G4, at the default size only: one Electron window, timed to the moment it maps.
        if (size.width === 1280) {
          const userData = await mkdtemp(join(tmpdir(), "orbit-electron-"));
          const at = performance.now();
          let outcome: string;
          try {
            await act({ type: "launch", toolkit: "wayland", argv: ["/usr/share/code/code", "--user-data-dir", userData, "--extensions-dir", join(userData, "extensions"), "--disable-workspace-trust", "--new-window"] });
            outcome = "mapped";
          } catch (error) { outcome = `not mapped: ${(error as { code?: string }).code ?? (error as Error).message}`; }
          const ms = Math.round(performance.now() - at);
          await Bun.sleep(1000);
          const shot = await call(broker.socket, "session.observe", session) as { image: string };
          await Bun.write(join(directory, `electron-${renderer.label.split(" ")[0]}.jpg`), Buffer.from(shot.image, "base64"));
          mapping.push({ renderer: renderer.label, fixture: "Visual Studio Code (Electron)", outcome, timeToMapMs: ms });
          console.log(JSON.stringify(mapping.at(-1)));
          await rm(userData, { recursive: true, force: true }).catch(() => {});
        }
      } finally { await broker.close(); }
    }
  }
  report.rows = rows; report.electron = mapping; report.status = "passed";
  report.notes = [
    "Frames were requested back to back with no viewer attached, the worst case for capture cost; compositorMsPerFrame is the sway process alone, read from /proc.",
    "desktopCompositorPercent is the person's Hyprland over the loop's interval, to be read against desktopIdlePercent, the same process at rest for 8 seconds before any session.",
    "The GPU rows use the integrated device chosen by boot_vga and pinned through ORBIT_NATIVE_RENDER_DEVICE; the discrete device is never opened.",
    "The Electron fixture is Visual Studio Code's Electron binary with a fresh user data directory, launched directly: the /usr/bin/code launcher starts it detached in a session of its own, whose window the backend rightly counts as nobody's. The launch waits 30 seconds for a window.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", rows, electron: mapping, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
