import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "../src/status";
import { activateVersion, automaticUpdates, launcherName, checkForUpdate, compareVersions, currentVersion, layout, prepareVersion, preparedVersions, pruneVersions, runUpdate, sameLine, setAutomaticUpdates, updatableInstall, updateStatus } from "../src/update";

/**
 * Activation, which is the part of an update that can hurt: it restarts the broker, and a restart ends
 * every open session because a session is state inside that process. Nothing here starts a broker or
 * touches systemd; the two things that reach the machine, restarting the service and asking the broker
 * whether it is alive, are injected.
 */
async function prepared(root: string, version: string) {
  const directory = join(layout(root).versions, version);
  await mkdir(join(directory, "bin"), { recursive: true });
  // The launcher activation actually looks for on this platform. Writing the bash name unconditionally
  // made the Windows branch of these tests agree with itself while a real Windows run refused every
  // activation with "is not a prepared version".
  await writeFile(join(directory, launcherName()), "#!/usr/bin/env bash\n");
  return directory;
}

/** An archive shaped like a release: one directory below the root, with a launcher in it. */
async function packFixture(root: string, version: string) {
  const tree = join(root, `fixture-${version}`, "package");
  await mkdir(join(tree, "bin"), { recursive: true });
  await writeFile(join(tree, "bin/sbar-orbit"), "#!/usr/bin/env bash\n");
  await writeFile(join(tree, "package.json"), JSON.stringify({ name: "sbar-orbit", version }));
  const archive = join(root, `${version}.tgz`);
  const packed = Bun.spawn(["tar", "czf", archive, "-C", join(root, `fixture-${version}`), "package"], { stdout: "pipe", stderr: "pipe" });
  if (await packed.exited !== 0) throw new Error("could not pack the fixture");
  return archive;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-update-"));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

test("a version is activated only when no session would be ended by it", async () => {
  const { root, close } = await fixture();
  try {
    await prepared(root, "0.1.0-alpha.4");
    await prepared(root, "0.1.0-alpha.5");
    const restarts: string[] = [];
    const environment = { root, restart: async () => { restarts.push("restart"); return { ok: true, output: "" }; }, healthy: async () => true };

    const busy = await activateVersion("0.1.0-alpha.5", { ...environment, openSessions: async () => 2 });
    expect(busy).toMatchObject({ activated: false, openSessions: 2 });
    expect(busy).toHaveProperty("reason", "a session is open, and activating would end it");
    // Nothing moved and nothing restarted, which is the whole promise.
    expect(restarts).toEqual([]);
    expect(await currentVersion(root)).toBeNull();

    const idle = await activateVersion("0.1.0-alpha.5", { ...environment, openSessions: async () => 0 });
    expect(idle).toMatchObject({ activated: true, version: "0.1.0-alpha.5", previous: null });
    expect(await currentVersion(root)).toBe("0.1.0-alpha.5");
    expect(restarts).toEqual(["restart"]);
  } finally { await close(); }
});

test("a broker that will not come up on the new version puts the old one back", async () => {
  const { root, close } = await fixture();
  try {
    await prepared(root, "1.0.0");
    await prepared(root, "1.1.0");
    const restarts: string[] = [];
    const good = { root, openSessions: async () => 0, restart: async () => { restarts.push("restart"); return { ok: true, output: "" }; }, healthy: async () => true };
    await activateVersion("1.0.0", good);

    const broken = await activateVersion("1.1.0", { ...good, healthy: async () => false });
    expect(broken).toMatchObject({ activated: false, rolledBack: true, version: "1.1.0", previous: "1.0.0" });
    // Back on the version that was working, and restarted again to get there.
    expect(await currentVersion(root)).toBe("1.0.0");
    expect(restarts).toEqual(["restart", "restart", "restart"]);
    // The version that failed is kept: it is the evidence, and deleting it would hide the failure.
    expect(await preparedVersions(root)).toEqual(["1.0.0", "1.1.0"]);
  } finally { await close(); }
});

test("a restart that fails is a rollback too, and says which half failed", async () => {
  const { root, close } = await fixture();
  try {
    await prepared(root, "1.0.0");
    await prepared(root, "1.1.0");
    const base = { root, openSessions: async () => 0, healthy: async () => true };
    await activateVersion("1.0.0", { ...base, restart: async () => ({ ok: true, output: "" }) });
    const failed = await activateVersion("1.1.0", { ...base, restart: async () => ({ ok: false, output: "Job for sbar-orbit.service failed" }) });
    expect(failed).toMatchObject({ activated: false, rolledBack: true });
    expect((failed as { reason: string }).reason).toContain("Job for sbar-orbit.service failed");
    expect(await currentVersion(root)).toBe("1.0.0");
  } finally { await close(); }
});

test("a version nobody prepared, and one that is already current, are refused without moving anything", async () => {
  const { root, close } = await fixture();
  try {
    await prepared(root, "2.0.0");
    const environment = { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }), healthy: async () => true };
    expect(await activateVersion("3.0.0", environment)).toMatchObject({ activated: false, reason: "3.0.0 is not a prepared version on this machine" });
    await activateVersion("2.0.0", environment);
    expect(await activateVersion("2.0.0", environment)).toMatchObject({ activated: false, reason: "2.0.0 is already the current version" });
  } finally { await close(); }
});

test("an install that runs from a source checkout is not one the updater may swap", async () => {
  const { root, close } = await fixture();
  try {
    const checkout = join(root, "checkout");
    await mkdir(join(checkout, "bin"), { recursive: true });
    await writeFile(join(checkout, "bin/sbar-orbit"), "#!/usr/bin/env bash\n");
    const link = join(root, "sbar-orbit");
    await symlink(join(checkout, "bin/sbar-orbit"), link);
    const refused = await updatableInstall(root, link);
    expect(refused.updatable).toBe(false);
    // The reason names the directory, because "not updatable" alone tells a person nothing.
    expect((refused as { reason: string }).reason).toContain(checkout);
    expect((refused as { reason: string }).reason).toContain("git");

    // The same machine once its launcher goes through a managed version.
    const directory = await prepared(root, "0.2.0");
    await rm(link);
    await symlink(join(directory, "bin/sbar-orbit"), link);
    expect((await updatableInstall(root, link)).updatable).toBe(true);
  } finally { await close(); }
});

test("status separates what is waiting from what could be activated right now", async () => {
  const { root, close } = await fixture();
  try {
    await prepared(root, "0.1.0");
    await prepared(root, "0.2.0");
    const environment = { root, restart: async () => ({ ok: true, output: "" }), healthy: async () => true };
    await activateVersion("0.1.0", { ...environment, openSessions: async () => 0 });

    const busy = await updateStatus({ ...environment, openSessions: async () => 1 });
    expect(busy).toMatchObject({ current: "0.1.0", pending: ["0.2.0"], openSessions: 1, canActivate: false });
    // A machine with no broker running is at a boundary as much as an idle one is.
    const stopped = await updateStatus({ ...environment, openSessions: async () => null });
    expect(stopped.openSessions).toBeNull();
    expect(stopped.managed).toBe(false);
    expect(stopped.reason).toBeDefined();
  } finally { await close(); }
});

test("pruning after a first activation keeps the newest spare by version, not by name", async () => {
  const { root, close } = await fixture();
  try {
    // The state a machine spends most of its life in: something current, nothing to roll back to yet.
    for (const version of ["0.1.0-alpha.2", "0.1.0-alpha.9", "0.1.0-alpha.10", "0.1.0-alpha.11"]) await prepared(root, version);
    await activateVersion("0.1.0-alpha.11", { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }), healthy: async () => true });
    const pruned = await pruneVersions(root);
    // alpha.10 sorts before alpha.9 in a directory listing, and it is the newer of the two.
    expect(pruned.removed.sort()).toEqual(["0.1.0-alpha.2", "0.1.0-alpha.9"]);
    expect((await preparedVersions(root)).sort()).toEqual(["0.1.0-alpha.10", "0.1.0-alpha.11"]);
  } finally { await close(); }
});

test("pruning keeps the current version and the one a rollback would need", async () => {
  const { root, close } = await fixture();
  try {
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) await prepared(root, version);
    const environment = { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }), healthy: async () => true };
    await activateVersion("0.3.0", environment);
    await activateVersion("0.4.0", environment);
    expect(await readlink(layout(root).previous)).toContain("0.3.0");
    const pruned = await pruneVersions(root, 0);
    expect(pruned.removed.sort()).toEqual(["0.1.0", "0.2.0"]);
    expect((await preparedVersions(root)).sort()).toEqual(["0.3.0", "0.4.0"]);
  } finally { await close(); }
});

/**
 * Finding and preparing a version. Every one of these runs against a fake feed: a test that reached the
 * real registry would be measuring the network, and one that downloaded a real archive would be
 * installing software as a side effect of running the suite.
 */
function feed(versions: Record<string, { publishedAt: string; bytes?: ArrayBuffer; integrity?: string }>) {
  const document = {
    versions: Object.fromEntries(Object.entries(versions).map(([version, entry]) =>
      [version, { dist: { tarball: `https://registry.test/${version}.tgz`, integrity: entry.integrity ?? "sha512-unset" } }])),
    time: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, entry.publishedAt])),
  };
  return {
    metadata: async () => document,
    download: async (url: string) => versions[url.split("/").at(-1)!.replace(".tgz", "")]?.bytes ?? new ArrayBuffer(0),
    now: () => Date.parse("2026-09-20T12:00:00Z"),
  };
}

test("versions are ordered the way the registry orders them, prereleases included", () => {
  expect(compareVersions("0.1.0-alpha.10", "0.1.0-alpha.9")).toBe(1);
  expect(compareVersions("0.1.0", "0.1.0-alpha.9")).toBe(1);
  expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  // With a zero major the minor is what a major is anywhere else, so 0.2 is not an update to 0.1.
  expect(sameLine("0.1.0-alpha.4", "0.1.0-alpha.5")).toBe(true);
  expect(sameLine("0.1.0", "0.2.0")).toBe(false);
  expect(sameLine("1.4.0", "1.9.2")).toBe(true);
  expect(sameLine("1.4.0", "2.0.0")).toBe(false);
});

test("a version younger than the maturation delay is found and refused, with its age", async () => {
  const fresh = await checkForUpdate("0.1.0-alpha.4", feed({
    "0.1.0-alpha.4": { publishedAt: "2026-09-01T00:00:00Z" },
    "0.1.0-alpha.5": { publishedAt: "2026-09-20T02:00:00Z" },
  }));
  expect(fresh.latest).toBe("0.1.0-alpha.5");
  expect(fresh.eligible).toBeNull();
  expect(fresh.reason).toBe("0.1.0-alpha.5 is 10 hours old and this machine waits 72");

  const matured = await checkForUpdate("0.1.0-alpha.4", feed({
    "0.1.0-alpha.4": { publishedAt: "2026-09-01T00:00:00Z" },
    "0.1.0-alpha.5": { publishedAt: "2026-09-16T00:00:00Z" },
  }));
  expect(matured.eligible).toMatchObject({ version: "0.1.0-alpha.5" });
});

test("a newer release line is reported and not taken", async () => {
  const across = await checkForUpdate("0.1.0-alpha.4", feed({
    "0.1.0-alpha.4": { publishedAt: "2026-09-01T00:00:00Z" },
    "0.2.0": { publishedAt: "2026-09-02T00:00:00Z" },
  }));
  expect(across.latest).toBe("0.2.0");
  expect(across.eligible).toBeNull();
  expect(across.reason).toContain("different release line");
  // And the newest eligible one inside the line wins, not the newest overall.
  const mixed = await checkForUpdate("0.1.0-alpha.4", feed({
    "0.1.0-alpha.5": { publishedAt: "2026-09-02T00:00:00Z" },
    "0.1.0-alpha.6": { publishedAt: "2026-09-03T00:00:00Z" },
    "0.2.0": { publishedAt: "2026-09-04T00:00:00Z" },
  }));
  expect(mixed.eligible).toMatchObject({ version: "0.1.0-alpha.6" });
});

test("an archive that does not match its published digest is refused and unpacks nothing", async () => {
  const { root, close } = await fixture();
  try {
    const real = await Bun.file(await packFixture(root, "0.1.0-alpha.9")).arrayBuffer();
    const wrong = await checkForUpdate("0.1.0-alpha.4", feed({
      "0.1.0-alpha.9": { publishedAt: "2026-09-01T00:00:00Z", bytes: real, integrity: "sha512-c29tZXRoaW5nRWxzZQ==" },
    }));
    const refused = await prepareVersion(wrong.eligible!, feed({
      "0.1.0-alpha.9": { publishedAt: "2026-09-01T00:00:00Z", bytes: real, integrity: "sha512-c29tZXRoaW5nRWxzZQ==" },
    }), { root, install: async () => ({ ok: true, output: "" }) });
    expect(refused).toMatchObject({ prepared: false });
    expect((refused as { reason: string }).reason).toContain("does not match the digest");
    expect(await preparedVersions(root)).toEqual([]);
  } finally { await close(); }
});

test("a verified archive becomes a prepared version, and nothing points at it yet", async () => {
  const { root, close } = await fixture();
  try {
    const archive = await packFixture(root, "0.1.0-alpha.9");
    const bytes = await Bun.file(archive).arrayBuffer();
    const integrity = `sha512-${Buffer.from(await crypto.subtle.digest("SHA-512", bytes)).toString("base64")}`;
    const source = feed({ "0.1.0-alpha.9": { publishedAt: "2026-09-01T00:00:00Z", bytes, integrity } });
    const found = await checkForUpdate("0.1.0-alpha.4", source);
    const prepared = await prepareVersion(found.eligible!, source, { root, install: async () => ({ ok: true, output: "" }) });
    expect(prepared).toMatchObject({ prepared: true, version: "0.1.0-alpha.9" });
    expect(await preparedVersions(root)).toEqual(["0.1.0-alpha.9"]);
    // Prepared is not activated: the link is still where it was, which is the whole separation.
    expect(await currentVersion(root)).toBeNull();
    const status = await updateStatus({ root, openSessions: async () => 0 });
    expect(status.pending).toEqual(["0.1.0-alpha.9"]);
  } finally { await close(); }
});

test("a dependency install that fails leaves no half prepared version behind", async () => {
  const { root, close } = await fixture();
  try {
    const bytes = await Bun.file(await packFixture(root, "0.1.0-alpha.9")).arrayBuffer();
    const integrity = `sha512-${Buffer.from(await crypto.subtle.digest("SHA-512", bytes)).toString("base64")}`;
    const source = feed({ "0.1.0-alpha.9": { publishedAt: "2026-09-01T00:00:00Z", bytes, integrity } });
    const found = await checkForUpdate("0.1.0-alpha.4", source);
    const failed = await prepareVersion(found.eligible!, source, { root, install: async () => ({ ok: false, output: "lockfile had changes" }) });
    expect(failed).toMatchObject({ prepared: false });
    expect((failed as { reason: string }).reason).toContain("lockfile had changes");
    expect(await preparedVersions(root)).toEqual([]);
  } finally { await close(); }
});

/**
 * The switch and the one command the timer runs. Off is the default, and absence means off: a machine
 * that has never been told anything must never update itself.
 */
test("automatic updates are off until somebody says otherwise, and off stops a run on its own", async () => {
  const { root, close } = await fixture();
  try {
    expect(await automaticUpdates(root)).toBe(false);
    const source = feed({ "0.1.0-alpha.9": { publishedAt: "2026-09-01T00:00:00Z" } });
    // Off is checked before the feed, the install shape and everything else, because the case the
    // switch exists for is the one where something is wrong.
    let asked = false;
    expect(await runUpdate("0.1.0-alpha.4", { root, ...source, metadata: async () => { asked = true; return (await source.metadata()); } }))
      .toMatchObject({ ran: false, reason: "automatic updates are off on this machine" });
    expect(asked).toBe(false);

    const timers: boolean[] = [];
    expect(await setAutomaticUpdates(true, root, async on => { timers.push(on); return { ok: true, output: "" }; }))
      .toMatchObject({ automatic: true, timer: "enabled" });
    expect(await automaticUpdates(root)).toBe(true);
    expect(await setAutomaticUpdates(false, root, async on => { timers.push(on); return { ok: true, output: "" }; }))
      .toMatchObject({ automatic: false, timer: "disabled" });
    expect(timers).toEqual([true, false]);
    // The file is the authority, so the switch still holds if the timer could not be touched.
    expect(await setAutomaticUpdates(true, root, async () => ({ ok: false, output: "Failed to connect to bus" })))
      .toMatchObject({ automatic: true, timer: "unchanged: Failed to connect to bus" });
    expect(await automaticUpdates(root)).toBe(true);
  } finally { await close(); }
});

test("a run on a source checkout prepares nothing, whatever the switch says", async () => {
  const { root, close } = await fixture();
  try {
    await setAutomaticUpdates(true, root, async () => ({ ok: true, output: "" }));
    // A launcher of the fixture's own, linked into a checkout rather than a managed version directory,
    // so the answer does not depend on what this machine has under ~/.local/bin.
    await mkdir(join(root, "checkout/bin"), { recursive: true });
    await writeFile(join(root, "checkout/bin/sbar-orbit"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink(join(root, "checkout/bin/sbar-orbit"), join(root, "launcher"));
    const outcome = await runUpdate("0.1.0-alpha.4", { root, launcher: join(root, "launcher"), ...feed({ "0.1.0-alpha.9": { publishedAt: "2026-09-01T00:00:00Z" } }) });
    expect(outcome.ran).toBe(false);
    expect(String(outcome.reason)).toContain("git");
  } finally { await close(); }
});

test("an idle machine with a version waiting says so in the one line a bar shows", () => {
  const idle = { socket: "/run/x", sampledAt: "", running: 0, paused: 0, working: 0, tabs: 0, windows: 0, sessions: [] };
  expect(summarize(idle)).toBe("Orbit idle");
  // The waiting version is visible rather than silent, which is what makes a machine that never
  // reaches a boundary explainable instead of just out of date.
  expect(summarize({ ...idle, pendingVersion: "0.1.0-alpha.9" })).toBe("Orbit idle, 0.1.0-alpha.9 waiting");
});

/**
 * The Windows branch of the version pointer, exercised on Linux by pretending to be win32.
 *
 * This is worth doing here rather than only on the guest, because the guest run is manual and this
 * path decides which version a machine boots. `process.platform` is read at call time, not captured,
 * so redefining it for the duration of the test reaches the same branch the guest does. The bytes on
 * disk are then checked directly: a pointer FILE, and no symlink.
 */
async function asWindows<T>(work: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try { return await work(); } finally { Object.defineProperty(process, "platform", real); }
}

test("on Windows the current version is a pointer file swapped by rename, not a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-winptr-"));
  try {
    const paths = layout(root);

    await asWindows(async () => {
      // Inside the override, so the fixture carries the launcher name a Windows install really has.
      await prepared(root, "1.0.0");
      await prepared(root, "2.0.0");
      expect(launcherName()).toBe("bin/sbar-orbit.cmd");
      const environment = { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }), healthy: async () => true };
      expect(await currentVersion(root)).toBeNull();
      expect(await activateVersion("1.0.0", environment)).toMatchObject({ activated: true });
      expect(await currentVersion(root)).toBe("1.0.0");

      // The pointer is a real file holding the target path, and `current` itself is never created.
      expect(await Bun.file(`${paths.current}.txt`).text()).toBe(join(paths.versions, "1.0.0"));
      expect(await Bun.file(paths.current).exists()).toBe(false);

      // A second activation must move the pointer and record the rollback target the same way.
      expect(await activateVersion("2.0.0", environment)).toMatchObject({ activated: true });
      expect(await currentVersion(root)).toBe("2.0.0");
      expect(await Bun.file(`${paths.previous}.txt`).text()).toBe(join(paths.versions, "1.0.0"));

      // And the rollback target must survive a prune, which is what the backslash split protects.
      const pruned = await pruneVersions(root, 0);
      expect(pruned.removed).toEqual([]);
      expect(pruned.kept.sort()).toEqual(["1.0.0", "2.0.0"]);
    });

    // No symlink was created at any point, which is the whole reason this branch exists.
    await expect(readlink(paths.current)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Linux only by definition: it asserts that a symlink was made, which Windows cannot do unelevated.
// Skipped rather than made conditional inside, so a Windows run reports it as not applicable instead
// of as a pass it never earned.
test.skipIf(process.platform === "win32")("the Linux install stays a symlink, so the Windows branch did not leak into it", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-linptr-"));
  try {
    await prepared(root, "1.0.0");
    const paths = layout(root);
    await activateVersion("1.0.0", { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }), healthy: async () => true });
    // A symlink, not a pointer file: the atomic rename over a live symlink is what Linux has and keeps.
    expect(await readlink(paths.current)).toBe(join(paths.versions, "1.0.0"));
    expect(await Bun.file(`${paths.current}.txt`).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
