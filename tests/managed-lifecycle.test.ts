import { releaseFixture } from "./managed-release-fixture";
import { expect, test, spyOn } from "bun:test";
import { mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activateLocal } from "../src/local-install";
import { activateVersion, currentVersion, launcherName, prepareManagedInstall, updatableInstall } from "../src/update";
import { brokerTaskXml } from "../src/windows-autostart";
import { managedLifecycle, updateAgentPlist, updateTaskXml, boundedCommand, type CommandRunner } from "../src/managed-lifecycle";
import { BROKER_LABEL, brokerAgentPlist, launchAgentPath } from "../src/macos-autostart";
import { installService } from "../src/service";
import { fixtureRoot } from "./platform-support";

async function asPlatform<T>(platform: string, work: () => Promise<T>) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (!original) throw new Error("Missing platform descriptor");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return await work(); } finally { Object.defineProperty(process, "platform", original); }
}

async function release(root: string) {
  await releaseFixture(root, "0.2.0");
}

test.skipIf(process.platform === "win32")("macOS managed launcher preserves current across activation", async () => {
  const root = await fixtureRoot("orbit-managed-mac-");
  try {
    const version = join(root, "versions/0.2.0");
    await release(version);
    await symlink(version, join(root, "current"));
    await asPlatform("darwin", async () => {
      const launcher = await activateLocal(join(root, "current"), join(root, "prefix"));
      expect(await readlink(launcher)).toBe(join(root, "current/bin/sbar-orbit"));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const platform of ["win32", "darwin"]) {
  test(`${platform} managed release dry-run plans without installing or activating`, async () => {
    const root = await fixtureRoot("orbit-managed-plan-");
    try {
      const origin = join(root, "release"), managed = join(root, "managed");
      await release(origin);
      await asPlatform(platform, async () => {
        const source = await prepareManagedInstall(origin, { root: managed, dryRun: true,
          install: async () => { throw new Error("dry-run installed dependencies"); },
          openSessions: async () => { throw new Error("dry-run queried broker"); } });
        expect(source).toBe(join(managed, "current"));
      });
      expect(await Bun.file(join(managed, "current.txt")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("Windows managed command is recognized through its real installed shim", async () => {
  const root = await fixtureRoot("orbit-managed-win-");
  try {
    const version = join(root, "versions/0.2.0");
    await release(version);
    await writeFile(join(root, "current.txt"), version);
    await asPlatform("win32", async () => {
      const launcher = await activateLocal(join(root, "current"), join(root, "prefix"));
      expect((await readFile(launcher, "utf8"))).toContain("sbar-orbit-managed-shim");
      expect(await updatableInstall(root, launcher)).toMatchObject({ updatable: true });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows logon task pins the installer Bun independently of the account PATH", () => {
  const task = brokerTaskXml("C:\\Orbit & tools\\sbar-orbit.cmd", "S-1-5-21-1-2-3-1000");
  expect(task).toContain("ORBIT_BUN");
  expect(task).toContain(process.execPath.replaceAll("&", "&amp;"));
});

const sid = "S-1-5-21-1-2-3-1000";
const winLauncher = "C:\\Orbit & tools\\sbar-orbit.cmd";

for (const mutation of [
  (xml: string) => xml.replace("</Actions>", "<Exec><Command>foreign.exe</Command></Exec></Actions>"),
  (xml: string) => xml.replace("<LogonType>InteractiveToken", "<LogonType>Password"),
  (xml: string) => xml.replaceAll(sid, "S-1-5-21-9-9-9-1000"),
  (xml: string) => xml.replace("<ExecutionTimeLimit>PT0S", "<ExecutionTimeLimit>PT1H"),
]) {
  test("Windows restart refuses mutated account task before End or Run", async () => {
    const commands: string[][] = [];
    const run: CommandRunner = async argv => { commands.push(argv); return { ok: true, output: mutation(brokerTaskXml(winLauncher, sid)) }; };
    const lifecycle = managedLifecycle({ launcher: winLauncher, socket: "fixture", platform: "win32", sid: async () => sid, run });
    expect(await lifecycle.restart()).toMatchObject({ ok: false });
    expect(commands).toHaveLength(1);
  });
}

test("Windows successor starts only after task exit is confirmed", async () => {
  const commands: string[][] = [];
  let polls = 0;
  const run: CommandRunner = async argv => {
    commands.push(argv);
    if (argv.includes("/XML")) return { ok: true, output: brokerTaskXml(winLauncher, sid) };
    if (argv[0] === "powershell.exe") return { ok: true, output: ++polls === 1 ? "Running" : "Ready" };
    return { ok: true, output: "" };
  };
  const lifecycle = managedLifecycle({ launcher: winLauncher, socket: "fixture", platform: "win32", sid: async () => sid, run });
  expect(await lifecycle.restart()).toMatchObject({ ok: true });
  expect(commands.map(argv => argv[1])).toEqual(["/Query", "/End", "-NoProfile", "-NoProfile", "/Run"]);
});

test("Windows stop failure prevents a successor start", async () => {
  const commands: string[][] = [];
  const run: CommandRunner = async argv => {
    commands.push(argv);
    return argv.includes("/XML") ? { ok: true, output: brokerTaskXml(winLauncher, sid) } : { ok: false, output: "stop failed" };
  };
  const lifecycle = managedLifecycle({ launcher: winLauncher, socket: "fixture", platform: "win32", sid: async () => sid, run });
  expect(await lifecycle.restart()).toMatchObject({ ok: false, output: "stop failed" });
  expect(commands.some(argv => argv.includes("/Run"))).toBe(false);
});

test("offline Windows off refuses drifted and unknown updater state and deletes only the exact owned task", async () => {
  const commands: string[][] = [];
  let unavailable = false, drifted = true;
  const run: CommandRunner = async argv => {
    commands.push(argv);
    if (unavailable) return { ok: false, output: "scheduler unavailable" };
    return { ok: true, output: argv.includes("/XML") ? (drifted ? updateTaskXml(winLauncher, sid).replace("PT20M", "PT30M") : updateTaskXml(winLauncher, sid)) : "" };
  };
  const lifecycle = managedLifecycle({ launcher: winLauncher, socket: "fixture", platform: "win32", sid: async () => sid, run });
  expect(await lifecycle.schedule(false)).toMatchObject({ ok: false });
  expect(commands.some(argv => argv.includes("/Delete"))).toBe(false);
  drifted = false;
  expect(await lifecycle.schedule(false)).toMatchObject({ ok: true });
  expect(commands.at(-1)).toContain("/Delete");
  unavailable = true;
  expect(await lifecycle.schedule(false)).toMatchObject({ ok: false });
});

test.skipIf(process.platform === "win32")("macOS restart refuses a different loaded GUI job", async () => {
  const root = await fixtureRoot("orbit-mac-owned-");
  try {
    const launcher = join(root, "bin/orbit"), socket = join(root, "broker.sock");
    const env = { HOME: root, ORBIT_LAUNCH_AGENTS_DIR: join(root, "agents") };
    const path = launchAgentPath(root, env);
    await mkdir(join(root, "agents"));
    await writeFile(path, brokerAgentPlist(launcher, socket, root, "/fixture/bun", {}));
    const commands: string[][] = [];
    const run: CommandRunner = async argv => { commands.push(argv); return { ok: true, output: `path = ${path}\nprogram = /foreign/launcher\ntype = LaunchAgent` }; };
    const lifecycle = managedLifecycle({ launcher, socket, home: root, env, platform: "darwin", uid: 501, run });
    expect(await lifecycle.restart()).toMatchObject({ ok: false });
    expect(commands).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("macOS rollback can bootstrap the previous version after a failed bootstrap", async () => {
  const root = await fixtureRoot("orbit-mac-rollback-");
  try {
    const launcher = join(root, "bin/orbit"), socket = join(root, "broker.sock");
    const env = { HOME: root, ORBIT_LAUNCH_AGENTS_DIR: join(root, "agents") };
    const path = launchAgentPath(root, env);
    await mkdir(join(root, "agents"));
    await writeFile(path, brokerAgentPlist(launcher, socket, root, "/fixture/bun", {}));
    let loaded = true, starts = 0;
    const run: CommandRunner = async argv => {
      if (argv[1] === "print") return loaded ? { ok: true,
        output: `path = ${path}\nprogram = ${launcher}\ntype = LaunchAgent\narguments = {\n${launcher}\nserve\n--managed-socket\n}\nenvironment = {\nORBIT_MANAGED_ENV_SCHEMA => 1\nHOME => ${root}\nORBIT_SOCKET => ${socket}\nORBIT_BUN => /fixture/bun/${process.execPath.split("/").at(-1)}\nPATH => /fixture/bun:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\n}` }
        : { ok: false, output: `Could not find service ${BROKER_LABEL}` };
      if (argv[1] === "bootout") { loaded = false; return { ok: true, output: "" }; }
      loaded = ++starts > 1;
      return { ok: loaded, output: loaded ? "" : "broken startup" };
    };
    const lifecycle = managedLifecycle({ launcher, socket, home: root, env, platform: "darwin", uid: 501, run });
    expect(await lifecycle.restart()).toMatchObject({ ok: false });
    expect(await lifecycle.restart()).toMatchObject({ ok: true });
    expect(starts).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("Linux restart refuses effective drop-ins and an un-reloaded unit", async () => {
  const root = await fixtureRoot("orbit-unit-owned-");
  try {
    const launcher = join(root, "orbit");
    await writeFile(launcher, "#!/bin/sh\n", { mode: 0o700 });
    await installService(launcher, root);
    const commands: string[][] = [];
    const run: CommandRunner = async argv => { commands.push(argv); return { ok: true,
      output: `FragmentPath=${join(root, "sbar-orbit.service")}\nDropInPaths=/foreign/override.conf\nNeedDaemonReload=no` }; };
    const lifecycle = managedLifecycle({ launcher, socket: "fixture", platform: "linux", env: { ORBIT_UNIT_DIR: root }, run });
    expect(await lifecycle.restart()).toMatchObject({ ok: false });
    expect(commands.some(argv => argv.includes("restart"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("update schedules preserve daily account scope and do not run at registration", () => {
  const mac = updateAgentPlist("/fixture/orbit", "/fixture/socket", "/fixture/home", "/fixture/bun", { ORBIT_BUN: "/fixture/bun/bun-pinned" });
  expect(mac).toContain("<integer>86400</integer>");
  expect(mac).not.toContain("<key>RunAtLoad</key>");
  expect(mac).not.toContain("<key>KeepAlive</key>");
  const windows = updateTaskXml(winLauncher, sid);
  expect(windows).toContain("<CalendarTrigger>");
  expect(windows).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(windows).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(windows).toContain(" update run</Arguments>");
});

test("lifecycle command deadline survives a process that ignores termination", async () => {
  const began = performance.now();
  const result = await boundedCommand([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], 150);
  expect(result).toEqual({ ok: false, output: "Lifecycle command timed out" });
  expect(performance.now() - began).toBeLessThan(2_000);
});

test("unconfirmed restart preserves the selected pointer and blocks later activation", async () => {
  const root = await fixtureRoot("orbit-activation-unconfirmed-");
  try {
    for (const version of ["0.1.0", "0.2.0"]) {
      await releaseFixture(join(root, "versions", version), version);
    }
    const base = { root, openSessions: async () => 0, healthy: async () => true };
    await activateVersion("0.1.0", { ...base, restart: async () => ({ ok: true, output: "" }) });
    let restarts = 0;
    const restart = async () => { restarts++; return { ok: false, output: "owned command exit not confirmed", stopUnconfirmed: true }; };
    expect(await activateVersion("0.2.0", { ...base, restart })).toMatchObject({ activated: false });
    expect(await currentVersion(root)).toBe("0.2.0");
    expect(JSON.parse(await readFile(join(root, "activation-recovery.json"), "utf8")))
      .toMatchObject({ version: "0.2.0", previous: "0.1.0", reason: "owned command exit not confirmed" });
    expect(await activateVersion("0.1.0", { ...base, restart })).toMatchObject({ activated: false });
    expect(await currentVersion(root)).toBe("0.2.0");
    expect(restarts).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("offline Linux off disables an owned drifted timer with effective ownership", async () => {
  const root = await fixtureRoot("orbit-off-owned-");
  try {
    const name = "sbar-orbit-update.timer", path = join(root, name);
    await writeFile(path, "[Unit]\nDescription=Sbar Orbit update check\n[Timer]\nOnCalendar=weekly\n");
    const commands: string[][] = [];
    const run: CommandRunner = async argv => { commands.push(argv); return { ok: true,
      output: `FragmentPath=${path}\nDescription=Sbar Orbit update check\nDropInPaths=` }; };
    const lifecycle = managedLifecycle({ launcher: join(root, "orbit"), socket: "fixture", platform: "linux", env: { ORBIT_UNIT_DIR: root }, run });
    expect(await lifecycle.schedule(false)).toMatchObject({ ok: true });
    expect(commands.at(-1)).toEqual(["systemctl", "--user", "disable", "--now", name]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unconfirmed rollback restart preserves recovery evidence and blocks another restart", async () => {
  const root = await fixtureRoot("orbit-rollback-unconfirmed-");
  try {
    for (const version of ["0.1.0", "0.2.0"]) {
      await releaseFixture(join(root, "versions", version), version);
    }
    const base = { root, openSessions: async () => 0 };
    await activateVersion("0.1.0", { ...base, healthy: async () => true, restart: async () => ({ ok: true, output: "" }) });
    let restarts = 0;
    const restart = async () => ++restarts === 1 ? { ok: true, output: "" }
      : { ok: false, output: "rollback command exit not confirmed", stopUnconfirmed: true };
    expect(await activateVersion("0.2.0", { ...base, restart, healthy: async () => false }))
      .toMatchObject({ activated: false, rolledBack: true, rollbackHealthy: false });
    expect(await currentVersion(root)).toBe("0.1.0");
    expect(JSON.parse(await readFile(join(root, "activation-recovery.json"), "utf8")))
      .toMatchObject({ version: "0.1.0", previous: "0.2.0",
        activationFailure: "0.2.0 did not answer doctor after its restart", rollbackFailure: "rollback command exit not confirmed",
        reason: "0.2.0 did not answer doctor after its restart; rollback restart failed: rollback command exit not confirmed" });
    expect(await activateVersion("0.2.0", { ...base, restart })).toMatchObject({ activated: false });
    expect(restarts).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unavailable pending recovery storage refuses activation before pointer or restart mutation", async () => {
  const root = await fixtureRoot("orbit-recovery-storage-");
  try {
    for (const version of ["0.1.0", "0.2.0"]) {
      await releaseFixture(join(root, "versions", version), version);
    }
    const base = { root, openSessions: async () => 0, healthy: async () => true };
    await activateVersion("0.1.0", { ...base, restart: async () => ({ ok: true, output: "" }) });
    // A directory cannot store the required recovery file. It must fail admission.
    await mkdir(join(root, "activation-recovery.json"));
    let restarts = 0;
    const result = await activateVersion("0.2.0", { ...base, restart: async () => {
      restarts++; return { ok: false, output: "owned stop unknown", stopUnconfirmed: true };
    } }).catch(error => ({ activated: false, reason: String(error) }));
    expect(result).toMatchObject({ activated: false });
    expect(restarts).toBe(0);
    expect(await currentVersion(root)).toBe("0.1.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const stage of ["activation", "rollback"]) {
  test(`${stage} persistence failure retains the preexisting pending barrier and original error`, async () => {
    const root = await fixtureRoot("orbit-recovery-persist-");
    let uuid: ReturnType<typeof spyOn> | undefined;
    try {
      for (const version of ["0.1.0", "0.2.0"]) {
        await releaseFixture(join(root, "versions", version), version);
      }
      const base = { root, openSessions: async () => 0 };
      await activateVersion("0.1.0", { ...base, healthy: async () => true, restart: async () => ({ ok: true, output: "" }) });
      let restarts = 0;
      const restart = async () => {
        restarts++;
        if (stage === "rollback" && restarts === 1) return { ok: true, output: "" };
        // Prevent a new evidence file from being created, without damaging the
        // already durable pending marker or the selected version pointer.
        const blocked = "00000000-0000-0000-0000-000000000000";
        await mkdir(join(root, `activation-recovery.json.${blocked}.tmp`));
        uuid = spyOn(crypto, "randomUUID").mockReturnValue(blocked);
        return { ok: false, output: `${stage} owned completion unknown`, stopUnconfirmed: true };
      };
      const result = await activateVersion("0.2.0", { ...base, restart, healthy: async () => false });
      uuid?.mockRestore(); uuid = undefined;
      expect(result).toMatchObject({ activated: false });
      expect((result as { reason: string }).reason).toContain(`${stage} owned completion unknown`);
      expect((result as { reason: string }).reason).toContain("recovery evidence update failed");
      const marker = JSON.parse(await readFile(join(root, "activation-recovery.json"), "utf8"));
      expect(marker.phase).toBe(stage === "activation" ? "pending" : "rollback-pending");
      expect(await currentVersion(root)).toBe(stage === "activation" ? "0.2.0" : "0.1.0");
      expect(await activateVersion(stage === "activation" ? "0.1.0" : "0.2.0", { ...base, restart }))
        .toMatchObject({ activated: false });
      expect(restarts).toBe(stage === "activation" ? 1 : 2);
    } finally { uuid?.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
}

test("confirmed rollback failure preserves both causes and durable diagnostic", async () => {
  const root = await fixtureRoot("orbit-rollback-errors-");
  try {
    for (const version of ["0.1.0", "0.2.0"]) {
      await releaseFixture(join(root, "versions", version), version);
    }
    const base = { root, openSessions: async () => 0, healthy: async () => true };
    await activateVersion("0.1.0", { ...base, restart: async () => ({ ok: true, output: "" }) });
    let restarts = 0;
    const result = await activateVersion("0.2.0", { ...base, restart: async () => ({ ok: false,
      output: ++restarts === 1 ? "activation startup failed" : "rollback startup failed" }) });
    const reason = (result as { reason: string }).reason;
    const diagnostic = await readFile(join(root, "activation-failure.json"), "utf8").then(JSON.parse).catch(() => null);
    expect({ result, diagnostic }).toMatchObject({
      result: { activated: false, rolledBack: true, rollbackHealthy: false,
        reason: expect.stringContaining("rollback startup failed") },
      diagnostic: { version: "0.2.0", previous: "0.1.0",
        activationFailure: expect.stringContaining("activation startup failed"), rollbackFailure: "rollback startup failed" },
    });
    expect(reason).toContain("activation startup failed");
    expect(await currentVersion(root)).toBe("0.1.0");
    expect(await Bun.file(join(root, "activation-recovery.json")).exists()).toBe(false);
    expect(restarts).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("confirmed rollback diagnostic persistence failure retains admission and both causes", async () => {
  const root = await fixtureRoot("orbit-rollback-diagnostic-storage-");
  let uuid: ReturnType<typeof spyOn> | undefined;
  try {
    for (const version of ["0.1.0", "0.2.0"]) {
      await releaseFixture(join(root, "versions", version), version);
    }
    const base = { root, openSessions: async () => 0, healthy: async () => true };
    await activateVersion("0.1.0", { ...base, restart: async () => ({ ok: true, output: "" }) });
    let restarts = 0;
    const restart = async () => {
      if (++restarts === 1) return { ok: false, output: "activation cause" };
      const blocked = "00000000-0000-0000-0000-000000000000";
      await mkdir(join(root, `activation-failure.json.${blocked}.tmp`));
      uuid = spyOn(crypto, "randomUUID").mockReturnValue(blocked);
      return { ok: false, output: "rollback cause" };
    };
    const result = await activateVersion("0.2.0", { ...base, restart });
    uuid?.mockRestore(); uuid = undefined;
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("activation cause");
    expect(reason).toContain("rollback cause");
    expect(reason).toContain("failure diagnostic persistence failed");
    expect(JSON.parse(await readFile(join(root, "activation-recovery.json"), "utf8")))
      .toMatchObject({ phase: "diagnostic-persistence-failed", activationFailure: expect.stringContaining("activation cause"), rollbackFailure: "rollback cause" });
    expect(await activateVersion("0.2.0", { ...base, restart })).toMatchObject({ activated: false });
    expect(restarts).toBe(2);
  } finally { uuid?.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("offline Linux off refuses a foreign named timer before disable", async () => {
  const root = await fixtureRoot("orbit-off-owner-");
  try {
    await writeFile(join(root, "sbar-orbit-update.timer"), "[Unit]\nDescription=Foreign timer\n");
    const commands: string[][] = [];
    const run: CommandRunner = async argv => { commands.push(argv); return { ok: true, output: "" }; };
    const lifecycle = managedLifecycle({ launcher: join(root, "orbit"), socket: "fixture", platform: "linux", env: { ORBIT_UNIT_DIR: root }, run });
    expect(await lifecycle.schedule(false)).toMatchObject({ ok: false });
    expect(commands.some(argv => argv.includes("disable"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("macOS restart refuses loaded argument and socket drift at the same launcher path", async () => {
  const root = await fixtureRoot("orbit-mac-effective-");
  try {
    const launcher = join(root, "bin/orbit"), socket = join(root, "broker.sock");
    const env = { HOME: root, ORBIT_LAUNCH_AGENTS_DIR: join(root, "agents") };
    const path = launchAgentPath(root, env);
    await mkdir(join(root, "agents"));
    await writeFile(path, brokerAgentPlist(launcher, socket, root, "/fixture/bun", {}));
    const commands: string[][] = [];
    const run: CommandRunner = async argv => { commands.push(argv); return { ok: true,
      output: `path = ${path}\nprogram = ${launcher}\ntype = LaunchAgent\narguments = {\n${launcher}\nserve\n--foreign-command\n}\nenvironment = {\nORBIT_SOCKET => /foreign/socket\nPATH => /foreign/bun\n}` }; };
    const lifecycle = managedLifecycle({ launcher, socket, home: root, env, platform: "darwin", uid: 501, run });
    expect(await lifecycle.restart()).toMatchObject({ ok: false });
    expect(commands).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle timeout waits for confirmed delayed command exit before resolving", async () => {
  let exited = false;
  let settle: (code: number) => void = () => {};
  const exit = new Promise<number>(resolve => { settle = resolve; });
  const pipe = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const fake = { stdout: pipe(), stderr: pipe(), exited: exit,
    kill: () => { setTimeout(() => { exited = true; settle(137); }, 100); return true; } };
  const spawn = spyOn(Bun, "spawn").mockReturnValue(fake as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const result = await boundedCommand(["fixture-command"], 10);
    expect(result.ok).toBe(false);
    expect(exited).toBe(true);
  } finally { spawn.mockRestore(); await exit; }
});
