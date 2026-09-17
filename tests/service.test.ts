import { test, expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
import { mkdtemp, readFile, writeFile, mkdir, stat, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { installService, uninstallService, serviceSocketPath, claimSocket, budget, connectorConfigDirectory } from "../src/service";
import { tmpdir } from "node:os";

/** Never the real unit directory: every case works inside a disposable prefix. */
async function prefix() {
  const root = await mkdtemp(join(tmpdir(), "orbit-service-test-"));
  const launcher = join(root, "sbar-orbit");
  await writeFile(launcher, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return { units: join(root, "units"), launcher, root };
}

// A systemd unit file, which Windows does not have and deliberately does not install: the launcher
// there installs no service at all, because a Chromium family browser cannot run in session 0 and the
// broker belongs in the person's own session. Asserting unit contents is asserting the Linux install.
linuxOnlySuite("the Windows install writes no service at all, by design, so there are no units to assert")(
  "installing writes a slice carrying the budget and a service bound to it", async () => {
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

// The first assertion joins a POSIX runtime directory with POSIX separators, which is what Linux
// does and what a Linux caller passes. On Windows `join` correctly returns backslashes, and
// XDG_RUNTIME_DIR is unset there anyway, so this is a Linux statement rather than a portable one.
// The Windows branch is pinned separately in tests/windows-host.test.ts.
test.skipIf(process.platform === "win32")("the managed socket path lives under the runtime directory", () => {
  expect(serviceSocketPath("/run/user/1000")).toBe("/run/user/1000/sbar-orbit/broker.sock");
  // An empty runtime directory is the missing case; passing undefined would select the default. The
  // platform is named rather than inherited, because Windows has no runtime directory and answers
  // with %LOCALAPPDATA% instead; that branch is pinned in tests/windows-host.test.ts.
  expect(() => serviceSocketPath("", process.env, "linux")).toThrow("XDG_RUNTIME_DIR");
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

/**
 * `stat` on a live Windows AF_UNIX socket answers EACCES, not ENOENT. The old code treated every
 * `stat` failure as "nothing is there", which on the guest left a stale socket file in place and
 * failed the bind with "Failed to listen on unix socket" and no cause. Only ENOENT may mean absent.
 */
test("a socket that cannot be inspected is probed, not assumed absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-claim-"));
  try {
    // A directory with no execute bit: `stat` on a path inside it fails with EACCES rather than
    // ENOENT, which is the shape a live Windows socket file presents. Skipped for root, who is not
    // stopped by the mode and would see ENOENT instead.
    const locked = join(root, "locked");
    await mkdir(locked, { recursive: true });
    const socket = join(locked, "broker.sock");
    await writeFile(socket, "");
    await chmod(locked, 0o000);
    try {
      let probed = false;
      await expect(claimSocket(socket, async () => { probed = true; return true; })).rejects.toThrow(/already serving/);
      expect(probed).toBe(true);
    } finally { await chmod(locked, 0o700); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * A missing path is still the ordinary case and must not be probed or unlinked.
 */
test("an absent socket path is claimed without probing anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-claim-absent-"));
  try {
    let probed = false;
    const claimed = await claimSocket(join(root, "nested", "broker.sock"), async () => { probed = true; return true; });
    expect(claimed).toMatchObject({ claimed: true, replacedStaleSocket: false });
    expect(probed).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * The connector configuration goes where each platform keeps configuration.
 *
 * Every other per user Orbit path already branches, `serviceSocketPath` and `workspaceRoot` among
 * them. This one did not, and the guest showed the result: the installer wrote
 * `%USERPROFILE%\.config\sbar-orbit\mcp.json`, a POSIX dotfile in a Windows profile, holding a
 * socket path written in Windows terms. Nothing on Windows looks in `.config`.
 *
 * Asserted per platform rather than with one shape that passes everywhere, for the reason the advisor
 * gate gives: a test that accepts both spellings is not guarding the rule, it is describing it.
 */
test("the connector configuration follows each platform's own configuration directory", () => {
  // A stand-in for a roaming profile, built rather than written as a literal user path: the
  // publication audit refuses those, and a real one would be somebody's machine.
  const roaming = join(tmpdir(), "AppData", "Roaming");
  const linux = connectorConfigDirectory({ XDG_CONFIG_HOME: join(tmpdir(), "config") }, "linux");
  expect(linux).toBe(join(tmpdir(), "config", "sbar-orbit"));

  // %APPDATA%, not %LOCALAPPDATA%: this is configuration a person may want to follow them between
  // machines, which is the distinction Windows draws. The socket and the workspaces stay local
  // because they are machine state, and this asserts the two do not get confused.
  const windows = connectorConfigDirectory({ APPDATA: roaming }, "win32");
  expect(windows).toBe(join(roaming, "sbar-orbit"));
  expect(windows).not.toContain(".config");
  expect(windows.toLowerCase()).not.toContain("local\\sbar-orbit");

  // A Windows machine with no APPDATA set still lands in the profile rather than at a relative path.
  const bare = connectorConfigDirectory({}, "win32");
  expect(bare).toContain(join("AppData", "Roaming"));
});
