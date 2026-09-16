import { test, expect } from "bun:test";
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

test("local source activation supports upgrade, rollback and removal while retaining data", async () => {
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

test("activation and removal refuse an unrelated command", async () => {
  const f = await fixture(), source = await f.source("0.1.0-alpha.1");
  await mkdir(join(f.prefix, "bin"), { recursive: true });
  const target = join(f.prefix, "bin/sbar-orbit");
  await writeFile(target, "unrelated command");
  await expect(activateLocal(source, f.prefix)).rejects.toThrow();
  await expect(deactivateLocal(f.prefix)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("unrelated command");
});

test("foreign links, invalid sources, symlinked bin and a held lock are rejected", async () => {
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

test("invalid replacement leaves the selected source intact", async () => {
  const f = await fixture(), good = await f.source("0.1.0-alpha.1"), bad = await f.source("0.1.0-alpha.2");
  const link = await activateLocal(good, f.prefix);
  await writeFile(join(bad, "package.json"), "{}");
  await expect(activateLocal(bad, f.prefix)).rejects.toThrow();
  expect(await readlink(link)).toBe(join(good, "bin/sbar-orbit"));
});

test("the actual checkout launcher can be activated outside the checkout and show help", async () => {
  const f = await fixture(), source = resolve(import.meta.dir, "..");
  const launcher = await activateLocal(source, f.prefix);
  try {
    const child = Bun.spawn([launcher, "--help"], { cwd: "/tmp", stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toContain("sbar-orbit serve");
    expect(await child.exited).toBe(0);
  } finally { await deactivateLocal(f.prefix); }
});
