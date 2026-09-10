import { test, expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { call, startBroker } from "../src/ipc";

async function descendants(pid: number): Promise<number[]> {
  try {
    const tasks = await readdir(`/proc/${pid}/task`);
    const children = new Set<number>();
    for (const task of tasks) {
      try { for (const id of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8")).split(/\s+/).filter(Boolean)) children.add(Number(id)); }
      catch {}
    }
    return [...children, ...(await Promise.all([...children].map(descendants))).flat()];
  } catch { return []; }
}

test("abrupt broker death reaps its browser tree and a fresh broker rejects stale sessions", async () => {
  const brokerProcess = Bun.spawn([process.execPath, "src/cli.ts", "serve"], { stdout: "pipe", stderr: "pipe" });
  const reader = brokerProcess.stdout.getReader();
  const errors = new Response(brokerProcess.stderr).text();
  try {
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Broker exited before startup");
      line += new TextDecoder().decode(chunk.value);
    }
    const { socket } = JSON.parse(line.split("\n")[0]!);
    const session = await call(socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const owned = await descendants(brokerProcess.pid);
    expect(owned.length).toBeGreaterThan(4);
    brokerProcess.kill("SIGKILL");
    await brokerProcess.exited;
    let alive: number[] = owned;
    for (let i = 0; i < 150; i++) {
      alive = (await Promise.all(owned.map(async pid => await Bun.file(`/proc/${pid}/stat`).exists() ? pid : null))).filter((pid): pid is number => pid !== null);
      if (!alive.length) break;
      await Bun.sleep(30);
    }
    expect(alive).toEqual([]);
    await expect(call(socket, "session.observe", session)).rejects.toBeDefined();
    const fresh = await startBroker();
    try {
      await expect(call(fresh.socket, "session.observe", session)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      const replacement = await call(fresh.socket, "session.create", { backend: "browser" }) as { sessionId: string };
      const frame = await call(fresh.socket, "session.observe", replacement) as { image: string };
      expect(Buffer.from(frame.image, "base64").subarray(1, 4).toString()).toBe("PNG");
      expect(await call(fresh.socket, "session.stop", replacement)).toMatchObject({ state: "closed" });
    } finally { await fresh.close(); }
  } finally {
    if (brokerProcess.exitCode === null) brokerProcess.kill("SIGKILL");
    await brokerProcess.exited;
    reader.releaseLock();
    await errors;
  }
}, 20000);
