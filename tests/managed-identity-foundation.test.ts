import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { releaseFixture } from "./managed-release-fixture";
import { fixtureRoot } from "./platform-support";
import { brokerIdentity, preparedIdentity, preparedIdentitySync, sameBrokerIdentity } from "../src/managed-identity";
import { managedLifecycle } from "../src/managed-lifecycle";
import { installService } from "../src/service";
import { activateVersion, currentVersion } from "../src/update";

test("broker identity compares every release, root and runtime field", async () => {
  const root = await fixtureRoot("orbit-foundation-health-");
  try {
    const directory = await releaseFixture(join(root, "versions/1.2.3"), "1.2.3");
    expect(preparedIdentitySync(root, "1.2.3")).toEqual(await preparedIdentity(root, "1.2.3"));
    const identity = await brokerIdentity(join(directory, "src"));
    expect(identity).not.toBeNull();
    if (!identity) throw new Error("Missing fixture identity");
    expect(sameBrokerIdentity(identity, identity)).toBe(true);
    for (const key of ["releaseDigest", "root", "directory", "runtime", "runtimeDigest", "version", "schema", "archiveIntegrity"]) {
      expect(sameBrokerIdentity({ ...identity, [key]: "different" }, identity)).toBe(false);
    }
    expect(sameBrokerIdentity({ version: "1.2.3" }, identity)).toBe(false);
    expect(await brokerIdentity(join(root, "checkout/src"))).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("executing broker cannot claim a release stamped for another runtime", async () => {
  const root = await fixtureRoot("orbit-foundation-runtime-");
  try {
    const other = join(root, process.platform === "win32" ? "other-bun.exe" : "other-bun");
    await copyFile(process.execPath, other);
    const directory = await releaseFixture(join(root, "versions/1.2.3"), "1.2.3", true, other);
    await expect(brokerIdentity(join(directory, "src"))).rejects.toThrow("runtime differs");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mechanism identity refusal precedes recovery and pointer mutation", async () => {
  const root = await fixtureRoot("orbit-foundation-preflight-");
  try {
    await releaseFixture(join(root, "versions/1.2.3"), "1.2.3");
    let restarts = 0;
    const lifecycle = { admit: async () => ({ ok: false, output: "wrong installed runtime" }),
      restart: async () => { restarts++; return { ok: true, output: "" }; }, schedule: async () => ({ ok: true, output: "" }) };
    expect(await activateVersion("1.2.3", { root, lifecycle, openSessions: async () => 0, healthy: async () => true }))
      .toMatchObject({ activated: false, reason: "wrong installed runtime" });
    expect(await currentVersion(root)).toBeNull();
    expect(await Bun.file(join(root, "activation-recovery.json")).exists()).toBe(false);
    expect(restarts).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("Linux installation identity admits recorded custom root and refuses runtime/root/operator overrides", async () => {
  const root = await fixtureRoot("orbit-foundation-mechanism-");
  const prior = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, ORBIT_BUN: process.env.ORBIT_BUN };
  try {
    const managed = join(root, "data/sbar-orbit"), config = join(root, "config"), units = join(root, "units");
    const directory = await releaseFixture(join(managed, "versions/1.2.3"), "1.2.3");
    await symlink(directory, join(managed, "current"));
    const launcher = join(root, "orbit"); await symlink(join(managed, "current/bin/sbar-orbit"), launcher);
    process.env.XDG_DATA_HOME = join(root, "data"); process.env.XDG_CONFIG_HOME = config; process.env.ORBIT_BUN = process.execPath;
    await installService(launcher, units);
    const lifecycle = managedLifecycle({ launcher, socket: "fixture", platform: "linux", env: { ORBIT_UNIT_DIR: units },
      run: async () => ({ ok: true, output: `FragmentPath=${join(units, "sbar-orbit.service")}\nDropInPaths=\nNeedDaemonReload=no` }) });
    const identity = { ...await preparedIdentity(managed, "1.2.3"), root: managed, directory };
    if (!lifecycle.admit) throw new Error("Missing identity admission");
    expect(await lifecycle.admit(identity)).toMatchObject({ ok: true });
    expect(await lifecycle.admit({ ...identity, root: join(root, "wrong") })).toMatchObject({ ok: false });
    expect(await lifecycle.admit({ ...identity, runtime: join(root, "wrong-bun") })).toMatchObject({ ok: false });
    await mkdir(join(config, "sbar-orbit"), { recursive: true });
    await writeFile(join(config, "sbar-orbit/broker.env"), "ORBIT_BUN=/foreign/bun\n");
    expect(await lifecycle.admit(identity)).toMatchObject({ ok: false });
    expect(await readFile(join(managed, "versions/1.2.3/package.json"), "utf8")).toContain("1.2.3");
  } finally {
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
