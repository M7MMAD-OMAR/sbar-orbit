import { test, expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
import { mkdtemp, readFile, readlink, writeFile, mkdir, stat, lstat, rm, chmod, symlink } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { OrbitError } from "../src/errors";
import { dirname, join, posix } from "node:path";
import { installService as writeService, uninstallService, serviceSocketPath, claimSocket, budget, connectorConfigDirectory } from "../src/service";
import { tmpdir } from "node:os";

const fixtureBunDirectory = "/fixture/runtime/bin";
const fixtureEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, ORBIT_BUN: `${fixtureBunDirectory}/bun` });
const installService = (launcher: string, units: string) => writeService(launcher, units, fixtureEnvironment(), fixtureBunDirectory);

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
  const expectedUnitMode = 0o644 & ~process.umask();
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
  expect((await stat(join(units, "sbar-orbit.service"))).mode & 0o777).toBe(expectedUnitMode);
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

test.skipIf(process.platform === "win32")("observed live owned socket is never probed or removed even when a probe would lie or throw", async () => {
  const { root } = await prefix(), socket = join(root, "runtime/sbar-orbit/broker.sock");
  let server: ReturnType<typeof Bun.serve> | undefined, startupUnknown = false, hits = 0, probes = 0;
  let failed = false, primary: unknown;
  try {
    expect(await claimSocket(socket, async () => { probes++; return false; })).toEqual({ claimed: true, replacedStaleSocket: false });
    startupUnknown = true;
    server = Bun.serve({ unix: socket, fetch: () => { hits++; return new Response("owned fixture"); } });
    startupUnknown = false;
    await writeFile(socket + ".owner", "OWNED-FIXTURE-CREDENTIAL", { mode: 0o600 });
    const before = await lstat(socket);
    const attempts: ((path: string) => Promise<boolean>)[] = [async () => { probes++; return false; },
      async () => { probes++; throw new Error("private-probe-error"); }, async () => { probes++; return true; }];
    for (const probe of attempts) {
      const failure: unknown = await claimSocket(socket, probe).catch(error => error);
      expect(failure).toBeInstanceOf(OrbitError); expect(failure).toMatchObject({ code: "CONFIG_REQUIRED" });
      if (!(failure instanceof OrbitError)) throw new Error("Expected fixed refusal");
      expect(failure.message).not.toContain(socket); expect(failure.message).not.toContain("private-probe-error");
      const after = await lstat(socket); expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    }
    expect(probes).toBe(0); expect(hits).toBe(0);
    expect(await readFile(socket + ".owner", "utf8")).toBe("OWNED-FIXTURE-CREDENTIAL");
    // Explicit test-only health check, not an admission probe and not peer authorization.
    const response = await fetch("http://localhost/", { unix: socket, signal: AbortSignal.timeout(1000) });
    expect(await response.text()).toBe("owned fixture"); expect(hits).toBe(1);
  } catch (error) { failed = true; primary = error; }
  try {
    if (startupUnknown) throw new Error("Owned listener startup unconfirmed; root retained");
    await server?.stop(true); await rm(root, { recursive: true, force: true });
  } catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "Owned socket fixture and cleanup failed"); throw cleanup; }
  if (failed) throw primary;
});

test("existing empty or nonempty regular files are refused without read-probe or deletion on every platform", async () => {
  const { root } = await prefix(), socket = join(root, "broker.sock"); let probes = 0;
  try {
    for (const contents of ["", "not a socket"]) {
      await writeFile(socket, contents); const before = await lstat(socket);
      await expect(claimSocket(socket, async () => { probes++; return false; })).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
      const after = await lstat(socket); expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(await readFile(socket, "utf8")).toBe(contents);
    }
    expect(probes).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("leaf symlinks including dangling links are refused without following or changing their target", async () => {
  const { root } = await prefix(), target = join(root, "target"), socket = join(root, "broker.sock");
  try {
    await writeFile(target, "owned target"); await symlink(target, socket);
    const before = await lstat(socket);
    await expect(claimSocket(socket, async () => { throw new Error("No probe"); })).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
    expect(await readlink(socket)).toBe(target); expect(await readFile(target, "utf8")).toBe("owned target");
    expect((await lstat(socket)).ino).toBe(before.ino);
    await rm(target);
    await expect(claimSocket(socket, async () => false)).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
    expect(await readlink(socket)).toBe(target); expect((await lstat(socket)).ino).toBe(before.ino);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing directory at socket leaf is refused with its contents unchanged", async () => {
  const { root } = await prefix(), socket = join(root, "broker.sock");
  try {
    await mkdir(socket); await writeFile(join(socket, "owned"), "keep");
    await expect(claimSocket(socket, async () => false)).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
    expect(await readFile(join(socket, "owned"), "utf8")).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parent creation and non-ENOENT inspection errors refuse without global filesystem mocks or probing", async () => {
  const source = await readFile(new URL("../src/service.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function claimSocket("), end = source.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end + 2).replace("export async", "async") + "\nglobalThis.__Claim = claimSocket;");
  for (const stage of ["mkdir", "lstat"]) for (const errno of stage === "mkdir" ? ["ENOENT", "EACCES", "EPERM", "EIO"] : ["EACCES", "EPERM", "EIO"]) {
    let parents = 0, inspected = 0, probes = 0;
    const context: Record<string, unknown> = { dirname, OrbitError, mkdir: async () => {
      parents++; if (stage === "mkdir") throw Object.assign(new Error("private-parent-message"), { code: errno });
    }, lstat: async () => {
      inspected++; throw Object.assign(new Error("private-filesystem-message"), { code: errno });
    } };
    runInNewContext(code, context);
    const isolated = context.__Claim as typeof claimSocket;
    const failure: unknown = await isolated("owned-unverified", async () => { probes++; return false; }).catch(error => error);
    expect(failure).toBeInstanceOf(OrbitError); expect(failure).toMatchObject({ code: "CONFIG_REQUIRED" });
    if (!(failure instanceof OrbitError)) throw new Error("Expected refusal");
    expect(failure.message).not.toContain("private-filesystem-message"); expect(failure.message).not.toContain("private-parent-message");
    expect(parents).toBe(1); expect(inspected).toBe(stage === "mkdir" ? 0 : 1); expect(probes).toBe(0);
  }
});

/** EACCES is not absence or live-owner proof on any platform. Existing and
 * uninspectable entries are both refused; the isolated test above covers errno
 * mapping even when privileged fixture users can traverse mode-restricted paths. */
// These fixtures deny directory traversal through POSIX mode bits. Windows uses ACLs.
test.skipIf(process.platform === "win32")("an existing mode-restricted entry is refused without probing or assuming absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-claim-"));
  try {
    // Non-root users may get EACCES; privileged users can still inspect the existing
    // leaf. Both outcomes must refuse it, and neither authorizes a probe or deletion.
    const locked = join(root, "locked");
    await mkdir(locked, { recursive: true });
    const socket = join(locked, "broker.sock");
    await writeFile(socket, "");
    await chmod(locked, 0o000);
    try {
      let probed = false;
      await expect(claimSocket(socket, async () => { probed = true; return true; })).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
      expect(probed).toBe(false);
    } finally { await chmod(locked, 0o700); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * The uninspectable branch must not DELETE either. It used to unlink whatever it found once the
 * probe said nobody was serving, with no shape test at all, which is the same guarantee the test
 * above pins on the other branch: refuse a person's file rather than remove it.
 */
test.skipIf(process.platform === "win32")("a path that cannot be inspected is refused, not deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-claim-opaque-"));
  try {
    const locked = join(root, "locked");
    await mkdir(locked, { recursive: true });
    const socket = join(locked, "broker.sock");
    await writeFile(socket, "someone's own file");
    await chmod(locked, 0o000);
    try {
      await expect(claimSocket(socket, async () => false)).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
    } finally { await chmod(locked, 0o700); }
    expect(await readFile(socket, "utf8")).toBe("someone's own file");
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
  // Asked in the SIMULATED platform's terms, not the host's: `join` is bound to the running machine,
  // so on Windows this compared a POSIX answer about Linux against a backslash path. The product is
  // right to answer POSIX for a POSIX platform whatever host computes it.
  const linuxConfig = posix.join(tmpdir().replace(/\\/g, "/"), "config");
  const linux = connectorConfigDirectory({ XDG_CONFIG_HOME: linuxConfig }, "linux");
  expect(linux).toBe(posix.join(linuxConfig, "sbar-orbit"));

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
