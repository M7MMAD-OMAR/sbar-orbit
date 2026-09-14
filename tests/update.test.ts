import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateVersion, currentVersion, layout, preparedVersions, pruneVersions, updatableInstall, updateStatus } from "../src/update";

/**
 * Activation, which is the part of an update that can hurt: it restarts the broker, and a restart ends
 * every open session because a session is state inside that process. Nothing here starts a broker or
 * touches systemd; the two things that reach the machine, restarting the service and asking the broker
 * whether it is alive, are injected.
 */
async function prepared(root: string, version: string) {
  const directory = join(layout(root).versions, version);
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(join(directory, "bin/sbar-orbit"), "#!/usr/bin/env bash\n");
  return directory;
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

test("pruning keeps the current version and the one a rollback would need", async () => {
  const { root, close } = await fixture();
  try {
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) await prepared(root, version);
    const environment = { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }), healthy: async () => true };
    await activateVersion("0.3.0", environment);
    await activateVersion("0.4.0", environment);
    expect(await readlink(layout(root).previous)).toContain("0.3.0");
    const pruned = await pruneVersions(root);
    expect(pruned.removed.sort()).toEqual(["0.1.0", "0.2.0"]);
    expect((await preparedVersions(root)).sort()).toEqual(["0.3.0", "0.4.0"]);
  } finally { await close(); }
});
