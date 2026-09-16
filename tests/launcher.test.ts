import { test, expect } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("launcher works through a symlink outside the repository and stops a nested bounded broker", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "orbit launcher-"));
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

/**
 * A systemd user service starts the launcher with the manager's PATH, which has no ~/.bun/bin in it.
 * Measured on an Ubuntu runner on 14 September 2026: the service exited 127 on every restart. The
 * launcher resolves bun by location, so the fake bun under a fake HOME is what runs here.
 */
test("the launcher finds bun under ~/.bun/bin when PATH has none, and says so when nothing has it", async () => {
  const home = await mkdtemp(join(tmpdir(), "orbit launcher-home-"));
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(join(home, ".bun/bin"), { recursive: true });
  const fake = join(home, ".bun/bin/bun");
  await writeFile(fake, '#!/bin/sh\necho "fake bun: $*"\n');
  await chmod(fake, 0o755);
  const bare = { HOME: home, PATH: "/usr/bin:/bin" };
  const found = Bun.spawn(["bash", resolve("bin/sbar-orbit"), "preflight"], { env: bare, stdout: "pipe", stderr: "pipe" });
  expect(await new Response(found.stdout).text()).toContain("fake bun: run");
  expect(await found.exited).toBe(0);
  const none = Bun.spawn(["bash", resolve("bin/sbar-orbit"), "preflight"], { env: { HOME: join(home, "empty"), PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(none.stderr).text(), none.exited]);
  expect(code).toBe(127);
  expect(err).toContain("bun was not found");
});
