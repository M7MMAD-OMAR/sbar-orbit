import { test, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { call } from "../src/ipc";

const enabled = process.env.ORBIT_TEST_NATIVE === "1";
async function descendants(pid: number): Promise<number[]> {
  try {
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
    return [...children, ...(await Promise.all(children.map(descendants))).flat()];
  } catch { return []; }
}
async function waitGone(pids: number[]) {
  for (let i = 0; i < 150; i++) {
    const alive = await Promise.all(pids.map(async pid => {
      try { return (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.[0] !== "Z"; } catch { return false; }
    }));
    if (!alive.some(Boolean)) return true;
    await Bun.sleep(30);
  }
  return false;
}
(enabled ? test : test.skip)("native trees terminate after abrupt broker death and a new broker works", async () => {
  const broker = Bun.spawn([process.execPath, "src/cli.ts", "serve"], { stdout: "pipe", stderr: "pipe" });
  const reader = broker.stdout.getReader();
  const root = await mkdtemp("/tmp/orbit-native-crash-");
  let owned: number[] = [];
  try {
    const first = await reader.read();
    const { socket } = JSON.parse(new TextDecoder().decode(first.value)) as { socket: string };
    const session = await call(socket, "session.create", { backend: "fedora" }) as { sessionId: string };
    await call(socket, "session.act", { ...session, requestId: "launch", action: { type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), join(root, "state.json")] } });
    owned = await descendants(broker.pid);
    expect(owned.length).toBeGreaterThan(4);
    broker.kill("SIGKILL"); await broker.exited;
    expect(await waitGone(owned)).toBe(true);
    await expect(call(socket, "session.observe", session)).rejects.toBeDefined();
    const { startBroker } = await import("../src/ipc");
    const fresh = await startBroker();
    try {
      expect(await call(fresh.socket, "session.create", { backend: "fedora" })).toMatchObject({ state: "running" });
      await expect(call(fresh.socket, "session.observe", session)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    } finally { await fresh.close(); }
  } finally {
    if (broker.exitCode === null) broker.kill("SIGKILL");
    await broker.exited;
    // The test only targets descendants captured while its own broker was alive.
    // Verify the Orbit runtime in each command before emergency cleanup.
    for (const pid of owned) {
      try {
        const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if (cmd.includes("/tmp/orbit-native-") || cmd.includes("sbar-orbit/.runtime/sway/pointer")) process.kill(pid, "SIGKILL");
      } catch {}
    }
    reader.releaseLock();
  }
}, 30000);

(enabled ? test : test.skip)("supervisor reaps detached descendants that ignore graceful termination", async () => {
  const root = await mkdtemp("/tmp/orbit-native-tree-");
  const pidFile = join(root, "tree.json");
  const code = `import os,signal,time,json\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npid=os.fork()\nif pid==0:\n os.setsid()\n time.sleep(60)\nelse:\n json.dump([os.getpid(),pid],open(${JSON.stringify(pidFile)},'w'))\n time.sleep(60)\n`;
  const supervisor = Bun.spawn(["/usr/bin/python3", "src/native/supervise.py", join(root, "root.json"), "/usr/bin/python3", "-c", code], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let pids: number[] = [];
  try {
    for (let i = 0; i < 100; i++) {
      try { pids = JSON.parse(await readFile(pidFile, "utf8")); break; } catch { await Bun.sleep(20); }
    }
    expect(pids.length).toBe(2);
    const started = performance.now();
    supervisor.stdin.end();
    expect(await supervisor.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
    for (const pid of pids) expect(await Bun.file(`/proc/${pid}/stat`).exists()).toBe(false);
  } finally {
    supervisor.stdin.end();
    await supervisor.exited;
  }
}, 10000);

(enabled ? test : test.skip)("compositor crash closes its session while another display survives", async () => {
  const { startBroker } = await import("../src/ipc");
  const broker = await startBroker();
  const root = await mkdtemp("/tmp/orbit-native-display-crash-");
  try {
    const a = await call(broker.socket, "session.create", { backend: "fedora" }) as { sessionId: string };
    const b = await call(broker.socket, "session.create", { backend: "fedora" }) as { sessionId: string };
    const launched = await call(broker.socket, "session.act", { ...a, requestId: "launch", action: { type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), join(root, "app.json")] } }) as { pid: number };
    const env = (await readFile(`/proc/${launched.pid}/environ`, "utf8")).split("\0");
    const runtime = env.find(v => v.startsWith("XDG_RUNTIME_DIR="))?.slice("XDG_RUNTIME_DIR=".length);
    if (!runtime?.startsWith("/tmp/orbit-native-")) throw new Error("Missing private runtime");
    const compositor = JSON.parse(await readFile(join(runtime, "compositor.json"), "utf8")) as { pid: number };
    process.kill(compositor.pid, "SIGKILL");
    expect(await waitGone([launched.pid, compositor.pid])).toBe(true);
    for (let i = 0; i < 100; i++) {
      const list = await call(broker.socket, "session.list") as { sessionId: string; state: string }[];
      if (list.find(s => s.sessionId === a.sessionId)?.state === "closed") break;
      await Bun.sleep(20);
    }
    await expect(call(broker.socket, "session.observe", a)).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(await call(broker.socket, "session.observe", b)).toMatchObject({ mimeType: "image/png" });
  } finally { await broker.close(); }
}, 20000);
