import { expect, test } from "bun:test";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { fixtureRoot, needsSymlink } from "./platform-support";

const fixturePrefix = "orbit-workspace-storage-test-";
const diskBase = resolve(import.meta.dir, "../output");
const ramTypes = [0x01021994, 0x858458f6];

async function ownedFixture(base = diskBase) {
  const root = await fixtureRoot(fixturePrefix, base);
  const parent = await realpath(dirname(root));
  return {
    root,
    async dispose() {
      // Remove only this exact, canonical mkdtemp child, never its base or siblings.
      if (dirname(root) !== parent || !basename(root).startsWith(fixturePrefix)
        || await realpath(root) !== root || (await lstat(root)).isSymbolicLink())
        throw new Error("Refusing cleanup outside the exact owned storage fixture");
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("disk-backed private storage creates distinct direct children and preserves siblings", async () => {
  const fixture = await ownedFixture();
  try {
    expect(ramTypes).not.toContain(Number((await statfs(fixture.root)).type) >>> 0);
    const root = join(fixture.root, "storage");
    await mkdir(root, { mode: 0o700 });
    const sibling = join(root, "existing-owner-marker");
    await writeFile(sibling, "keep this fixture sibling");
    const first = await createWorkspaceDirectory("fixture", root);
    const second = await createWorkspaceDirectory("fixture", root);
    expect(first).not.toBe(second);
    for (const child of [first, second]) {
      expect(dirname(child)).toBe(root);
      expect(basename(child).startsWith("fixture-")).toBe(true);
      const info = await lstat(child);
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o700);
    }
    expect(await readFile(sibling, "utf8")).toBe("keep this fixture sibling");
    expect((await readdir(root)).sort()).toEqual([basename(first), basename(second), basename(sibling)].sort());
  } finally { await fixture.dispose(); }
});

test("invalid prefixes and a relative storage path fail before filesystem mutation", async () => {
  const fixture = await ownedFixture();
  try {
    const root = join(fixture.root, "not-created");
    for (const prefix of ["", "../escape", "with/slash", "Uppercase", "-leading", "space prefix", "dot.name"])
      await expect(createWorkspaceDirectory(prefix, root)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(createWorkspaceDirectory("fixture", "relative-storage")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await readdir(fixture.root)).toEqual([]);
  } finally { await fixture.dispose(); }
});

test("a regular-file root is refused without changing its contents", async () => {
  const fixture = await ownedFixture();
  try {
    const root = join(fixture.root, "file-root");
    await writeFile(root, "not a workspace directory");
    await expect(createWorkspaceDirectory("fixture", root)).rejects.toThrow();
    expect(await readFile(root, "utf8")).toBe("not a workspace directory");
    expect(await readdir(fixture.root)).toEqual(["file-root"]);
  } finally { await fixture.dispose(); }
});

needsSymlink("the storage-root refusal fixture needs a real directory symlink")(
  "a symlink root is refused without writing into its target", async () => {
    const fixture = await ownedFixture();
    try {
      const target = join(fixture.root, "target"), linked = join(fixture.root, "linked-root");
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, "marker"), "target stays unchanged");
      await symlink(target, linked, "dir");
      await expect(createWorkspaceDirectory("fixture", linked)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(await readdir(target)).toEqual(["marker"]);
      expect(await readFile(join(target, "marker"), "utf8")).toBe("target stays unchanged");
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    } finally { await fixture.dispose(); }
  },
);

(process.platform === "win32" ? test.skip : test)("a POSIX group/world-readable root is refused", async () => {
  const fixture = await ownedFixture();
  try {
    const root = join(fixture.root, "public-root");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o755);
    expect((await lstat(root)).mode & 0o077).not.toBe(0);
    await expect(createWorkspaceDirectory("fixture", root)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await readdir(root)).toEqual([]);
  } finally { await fixture.dispose(); }
});

const ramAvailable = process.platform === "linux" && await (async () => {
  try {
    await access("/dev/shm", constants.W_OK);
    return ramTypes.includes(Number((await statfs("/dev/shm")).type) >>> 0);
  } catch { return false; }
})();

(ramAvailable ? test : test.skip)("a real Linux RAM filesystem is refused before allocating a workspace", async () => {
  const fixture = await ownedFixture("/dev/shm");
  try {
    const root = join(fixture.root, "ram-root");
    await expect(createWorkspaceDirectory("fixture", root)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await readdir(root)).toEqual([]);
  } finally { await fixture.dispose(); }
});
