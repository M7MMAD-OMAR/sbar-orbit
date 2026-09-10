import { test, expect } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

test("launcher works through a symlink outside the repository and stops a nested bounded broker", async () => {
  const scratch = await mkdtemp("/tmp/orbit launcher-");
  const launcher = join(scratch, "sbar-orbit");
  await symlink(resolve("bin/sbar-orbit"), launcher);
  const help = Bun.spawn([launcher, "--help"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
  expect(await new Response(help.stdout).text()).toContain("connector-config");
  expect(await help.exited).toBe(0);
  const broker = Bun.spawn([launcher, "serve"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
  const reader = broker.stdout.getReader();
  const stderr = new Response(broker.stderr).text();
  try {
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Launcher exited before broker startup");
      line += new TextDecoder().decode(chunk.value);
    }
    const { socket } = JSON.parse(line.split("\n")[0]!);
    const invoke = async (command: string) => {
      const child = Bun.spawn([launcher, command], { cwd: scratch, env: { ...process.env, ORBIT_SOCKET: socket }, stdout: "pipe", stderr: "pipe" });
      const [text, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0);
      return JSON.parse(text);
    };
    expect(await invoke("doctor")).toMatchObject({ ok: true, result: { sessions: 0, resources: { scope: "all-orbit-jobs" } } });
    expect(await invoke("connector-config")).toMatchObject({ mcpServers: { orbit: { env: { ORBIT_SOCKET: socket } } } });
    broker.kill("SIGTERM");
    expect(await Promise.race([broker.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(0);
    await expect(fetch("http://localhost/rpc", { unix: socket, method: "POST", body: '{}' })).rejects.toBeDefined();
  } finally {
    if (broker.exitCode === null) broker.kill("SIGKILL");
    await broker.exited; reader.releaseLock(); await stderr;
  }
}, 15000);
