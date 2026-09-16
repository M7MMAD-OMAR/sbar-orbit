import { test, expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { activateLocal, deactivateLocal } from "../src/local-install";
import { tmpdir } from "node:os";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-install-test-"));
  const prefix = join(root, "local prefix");
  async function source(version: string) {
    const path = join(root, version);
    await mkdir(join(path, "bin"), { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name: "sbar-orbit", version }));
    await writeFile(join(path, "bin/sbar-orbit"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
    return path;
  }
  return { root, prefix, source };
}

linuxOnlySuite("these assert readlink on the installed command and run #!/bin/sh launchers; Windows cannot create the symlink unelevated and installs a .cmd shim instead, covered below")("local source activation supports upgrade, rollback and removal while retaining data", async () => {
  const f = await fixture(), v1 = await f.source("0.1.0-alpha.1"), v2 = await f.source("0.1.0-alpha.2");
  const sentinel = join(f.root, "retained-account-state");
  await writeFile(sentinel, "fixture");
  for (const [source, version] of [[v1, "0.1.0-alpha.1"], [v2, "0.1.0-alpha.2"], [v1, "0.1.0-alpha.1"]] as const) {
    const launcher = await activateLocal(source, f.prefix);
    expect(await readlink(launcher)).toBe(join(source, "bin/sbar-orbit"));
    const child = Bun.spawn([launcher, "--help"], { cwd: "/tmp", stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe(version);
    expect(await child.exited).toBe(0);
  }
  await deactivateLocal(f.prefix);
  expect(await lstat(join(f.prefix, "bin/sbar-orbit")).catch(() => null)).toBeNull();
  expect(await readFile(sentinel, "utf8")).toBe("fixture");
  expect((await lstat(join(v1, "bin/sbar-orbit"))).isFile()).toBe(true);
  expect((await lstat(join(v2, "bin/sbar-orbit"))).isFile()).toBe(true);
});

linuxOnlySuite("these assert readlink on the installed command and run #!/bin/sh launchers; Windows cannot create the symlink unelevated and installs a .cmd shim instead, covered below")("activation and removal refuse an unrelated command", async () => {
  const f = await fixture(), source = await f.source("0.1.0-alpha.1");
  await mkdir(join(f.prefix, "bin"), { recursive: true });
  const target = join(f.prefix, "bin/sbar-orbit");
  await writeFile(target, "unrelated command");
  await expect(activateLocal(source, f.prefix)).rejects.toThrow();
  await expect(deactivateLocal(f.prefix)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("unrelated command");
});

linuxOnlySuite("these assert readlink on the installed command and run #!/bin/sh launchers; Windows cannot create the symlink unelevated and installs a .cmd shim instead, covered below")("foreign links, invalid sources, symlinked bin and a held lock are rejected", async () => {
  const f = await fixture(), source = await f.source("0.1.0-alpha.1");
  await mkdir(join(f.prefix, "bin"), { recursive: true });
  await symlink("/bin/sh", join(f.prefix, "bin/sbar-orbit"));
  await expect(activateLocal(source, f.prefix)).rejects.toThrow();
  await expect(deactivateLocal(f.prefix)).rejects.toThrow();
  expect(await readlink(join(f.prefix, "bin/sbar-orbit"))).toBe("/bin/sh");
  const otherPrefix = join(f.root, "other");
  await mkdir(otherPrefix); await symlink(join(f.prefix, "bin"), join(otherPrefix, "bin"));
  await expect(activateLocal(source, otherPrefix)).rejects.toThrow();
  const locked = join(f.root, "locked");
  await mkdir(join(locked, "bin/.sbar-orbit-install-lock"), { recursive: true });
  await expect(activateLocal(source, locked)).rejects.toThrow();
  expect((await lstat(join(locked, "bin/.sbar-orbit-install-lock"))).isDirectory()).toBe(true);
  await writeFile(join(source, "package.json"), '{"name":"other","version":"1.0.0"}');
  await expect(activateLocal(source, join(f.root, "invalid"))).rejects.toThrow();
});

linuxOnlySuite("these assert readlink on the installed command and run #!/bin/sh launchers; Windows cannot create the symlink unelevated and installs a .cmd shim instead, covered below")("invalid replacement leaves the selected source intact", async () => {
  const f = await fixture(), good = await f.source("0.1.0-alpha.1"), bad = await f.source("0.1.0-alpha.2");
  const link = await activateLocal(good, f.prefix);
  await writeFile(join(bad, "package.json"), "{}");
  await expect(activateLocal(bad, f.prefix)).rejects.toThrow();
  expect(await readlink(link)).toBe(join(good, "bin/sbar-orbit"));
});

linuxOnlySuite("these assert readlink on the installed command and run #!/bin/sh launchers; Windows cannot create the symlink unelevated and installs a .cmd shim instead, covered below")("the actual checkout launcher can be activated outside the checkout and show help", async () => {
  const f = await fixture(), source = resolve(import.meta.dir, "..");
  const launcher = await activateLocal(source, f.prefix);
  try {
    const child = Bun.spawn([launcher, "--help"], { cwd: "/tmp", stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toContain("sbar-orbit serve");
    expect(await child.exited).toBe(0);
  } finally { await deactivateLocal(f.prefix); }
});

/**
 * The Windows install path, exercised on Linux by pretending to be win32.
 *
 * The suites above are skipped on Windows because their subject is the symlink. That is only honest
 * if the thing Windows does instead is tested rather than left as a hole, which is exactly the trap
 * `platform-support.ts` warns about: a skip that hides a defect instead of naming a decision.
 *
 * `process.platform` is read at call time, so redefining it reaches the same branch a Windows host
 * does. What cannot be simulated is whether Windows permits the rename, and that was measured
 * separately on the guest; what is checked here is the shape, the marker, and the refusal.
 */
async function asWindows<T>(work: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try { return await work(); } finally { Object.defineProperty(process, "platform", real); }
}

test("on Windows the installed command is a marker carrying shim, and a foreign file is refused", async () => {
  const f = await fixture();
  await asWindows(async () => {
    const source = await f.source("0.1.0-alpha.1");
    // The fixture's launcher has to be the one a Windows install looks for.
    await writeFile(join(source, "bin", "sbar-orbit.cmd"), "@echo off\r\n");

    const installed = await activateLocal(source, f.prefix);
    expect(installed).toBe(join(f.prefix, "bin", "sbar-orbit.cmd"));
    const shim = await readFile(installed, "utf8");
    // The marker is what lets checkExisting tell Orbit's own file from a person's batch file.
    expect(shim).toContain("sbar-orbit-managed-shim");
    // It forwards every argument and keeps the exit code, which is what `call ... %*` buys.
    expect(shim).toContain(`@call "${join(source, "bin", "sbar-orbit.cmd")}" %*`);
    // No symlink was created, which is the whole reason this branch exists.
    await expect(readlink(installed)).rejects.toThrow();

    // Re-activating the same source is safe and leaves one file, not two.
    expect(await activateLocal(source, f.prefix)).toBe(installed);

    // A file that is not ours is refused, and left byte for byte intact. Losing this in the port
    // would be worse than losing the shim: it is the check that protects a person's own command.
    await writeFile(installed, "@echo off\r\necho someone else's\r\n");
    await expect(activateLocal(source, f.prefix)).rejects.toThrow(/not a recognized Orbit source launcher/);
    expect(await readFile(installed, "utf8")).toContain("someone else's");

    // And deactivating refuses it too, rather than deleting it.
    await expect(deactivateLocal(f.prefix)).rejects.toThrow(/not a recognized Orbit source launcher/);
    expect(await readFile(installed, "utf8")).toContain("someone else's");
  });
});
