import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { installService, uninstallService, serviceSocketPath, claimSocket, budget } from "../src/service";
import { tmpdir } from "node:os";

/** Never the real unit directory: every case works inside a disposable prefix. */
async function prefix() {
  const root = await mkdtemp(join(tmpdir(), "orbit-service-test-"));
  const launcher = join(root, "sbar-orbit");
  await writeFile(launcher, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return { units: join(root, "units"), launcher, root };
}

test("installing writes a slice carrying the budget and a service bound to it", async () => {
  const { units, launcher } = await prefix();
  const result = await installService(launcher, units);
  expect(result.written.map(path => path.split("/").at(-1)).sort())
    .toEqual(["sbar-orbit-update.service", "sbar-orbit-update.timer", "sbar-orbit.service", "sbarorbit.slice"]);
  expect(result).toMatchObject({ enabled: false, started: false });

  // The update pair is written by every install and enabled by none of it: `update on` is the only
  // thing that starts the timer. A machine that has never been told anything never updates itself.
  const timer = await readFile(join(units, "sbar-orbit-update.timer"), "utf8");
  expect(timer).toContain("OnCalendar=daily");
  // A release must not reach every machine in the same minute, and a machine that was asleep still checks.
  expect(timer).toContain("RandomizedDelaySec=4h");
  expect(timer).toContain("Persistent=true");
  const check = await readFile(join(units, "sbar-orbit-update.service"), "utf8");
  expect(check).toContain(`ExecStart=${launcher} update run`);
  expect(check).toContain("Slice=sbarorbit.slice");

  // The broker looks for sbarorbit.slice in its own cgroup path, so the budget must live there.
  const slice = await readFile(join(units, "sbarorbit.slice"), "utf8");
  for (const [key, value] of Object.entries(budget)) expect(slice).toContain(`${key}=${value}`);

  const service = await readFile(join(units, "sbar-orbit.service"), "utf8");
  expect(service).toContain("Slice=sbarorbit.slice");
  expect(service).toContain(`ExecStart=${launcher} serve --managed-socket`);
  expect(service).toContain("Restart=on-failure");
  // Owned browsers and private displays need time to close.
  expect(service).toContain("TimeoutStopSec=30");
  expect((await stat(join(units, "sbar-orbit.service"))).mode & 0o777).toBe(0o644);
});

test("installing twice replaces the units without leaving temporary files", async () => {
  const { units, launcher } = await prefix();
  await installService(launcher, units);
  await installService(launcher, units);
  const { readdir } = await import("node:fs/promises");
  expect((await readdir(units)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("installing refuses a launcher that is not a regular file", async () => {
  const { units, root } = await prefix();
  await expect(installService(join(root, "missing"), units)).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
});

test("uninstalling removes only units Orbit wrote", async () => {
  const { units, launcher } = await prefix();
  await installService(launcher, units);
  expect(await uninstallService(units)).toMatchObject({ sourceAndDataRetained: true });
  await mkdir(units, { recursive: true });
  await writeFile(join(units, "sbar-orbit.service"), "[Unit]\nDescription=Someone else\n");
  await expect(uninstallService(units)).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
  expect(await readFile(join(units, "sbar-orbit.service"), "utf8")).toContain("Someone else");
});

test("uninstalling an absent installation is not an error", async () => {
  const { units } = await prefix();
  expect(await uninstallService(units)).toEqual({ removed: [], sourceAndDataRetained: true });
});

test("the managed socket path lives under the runtime directory", () => {
  expect(serviceSocketPath("/run/user/1000")).toBe("/run/user/1000/sbar-orbit/broker.sock");
  // An empty runtime directory is the missing case; passing undefined would select the default.
  expect(() => serviceSocketPath("")).toThrow("XDG_RUNTIME_DIR");
});

test("claiming refuses a live broker and clears only a dead socket", async () => {
  const { root } = await prefix();
  const socket = join(root, "runtime/sbar-orbit/broker.sock");
  expect(await claimSocket(socket, async () => false)).toEqual({ claimed: true, replacedStaleSocket: false });

  const server = Bun.serve({ unix: socket, fetch: () => new Response("ok") });
  try {
    await expect(claimSocket(socket, async () => true)).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    // A socket file nothing answers on is stale, and Bun refuses to bind over it, so it is removed.
    expect(await claimSocket(socket, async () => false)).toEqual({ claimed: true, replacedStaleSocket: true });
  } finally { server.stop(true); }
});

test("claiming refuses to remove a path that is not a socket", async () => {
  const { root } = await prefix();
  const socket = join(root, "runtime/sbar-orbit/broker.sock");
  await mkdir(join(root, "runtime/sbar-orbit"), { recursive: true });
  await writeFile(socket, "not a socket");
  await expect(claimSocket(socket, async () => false)).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
  expect(await readFile(socket, "utf8")).toBe("not a socket");
});
