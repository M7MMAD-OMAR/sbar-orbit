import { expect, test } from "bun:test";
import { needsCommand, needsGitCheckout, symlinkCapable } from "./platform-support";
import { bareLineFeeds } from "../scripts/package-endings";
import { chmod, mkdir, mkdtemp, rm, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNativeRuntime } from "../src/install";
import { registryPackage } from "../scripts/registry-package";

/**
 * What leaves this machine for the registry. The source archive in `scripts/package.ts` is built from
 * the git index, so nothing untracked can reach it; the registry tarball uses Git's tracked paths
 * with current working tree bytes, then applies the `files` list through `bun pm pack`.
 * Nothing tested it, and `0.1.0-alpha.3` shipped six `__pycache__` files because of that.
 *
 * This packs with bun, which is the only packer this project uses. `npm pack --dry-run` was checked by
 * hand on 13 September 2026 and agrees with it on both the exclusion and the lockfile, since a negation
 * entry in `files` is resolved by whichever tool the publisher runs and the two need not agree.
 */
const project = resolve(import.meta.dir, "..");

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${err.trim() || out.trim()}`);
  return out;
}

needsCommand("git", "the fixture creates its own Git index to select package inputs")(
  "registry packaging excludes untracked fixture files while preserving current tracked bytes and modes", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orbit-pack-fixture-"));
  const source = join(fixture, "source");
  const destination = join(fixture, "archives");
  try {
    await mkdir(source);
    await run(["git", "init", "--quiet"], source);
    const lock = await Bun.file(join(project, "bun.lock")).text();
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "orbit-pack-fixture", version: "1.0.0",
        bin: { orbit: "bin/orbit" }, files: ["src", "docs", "bin", "install.cmd", "bun.lock"] }),
      "bun.lock": lock,
      "README.md": "tracked readme\n",
      "LICENSE": "tracked license\n",
      "src/tracked.ts": "export const value = 'indexed';\n",
      "docs/tracked.md": "indexed docs\n",
      "bin/orbit": "#!/bin/sh\nexit 0\n",
      "bin/orbit.cmd": "@echo off\r\nexit /b 0\r\n",
      "install.cmd": "@echo off\r\nexit /b 0\r\n",
      "private.txt": "tracked but outside the package files list\n",
      "src/.env": "tracked private environment\n",
      "src/secret.key": "tracked private key\n",
      "docs/evidence/private.md": "tracked private evidence\n",
      "docs/superpowers/private.md": "tracked private notes\n",
      "src/.env.example": "public environment example\n",
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(resolve(source, path, ".."), { recursive: true });
      await Bun.write(join(source, path), contents);
    }
    await chmod(join(source, "bin/orbit"), 0o755);
    await run(["git", "add", "."], source);
    // These edits are deliberately unstaged: Git supplies membership, not content.
    await Bun.write(join(source, "src/tracked.ts"), "export const value = 'working tree';\n");
    await Bun.write(join(source, "docs/tracked.md"), "working tree docs\n");
    await Bun.write(join(source, "bun.lock"), `${lock}\n`);
    await Bun.write(join(source, "src/untracked.ts"), "must not ship\n");
    await Bun.write(join(source, "docs/untracked.md"), "must not ship\n");
    // A private tracked path is filtered before filesystem inspection or copying.
    if (symlinkCapable) {
      await rm(join(source, "src/secret.key"));
      await symlink(join(fixture, "absent-private-key"), join(source, "src/secret.key"));
    }
    const archive = await registryPackage(destination, source);
    const shipped = (await run(["tar", "tzf", archive], fixture)).split(/\r?\n/).filter(Boolean);
    expect(shipped).not.toContain("package/src/untracked.ts");
    expect(shipped).not.toContain("package/docs/untracked.md");
    expect(shipped).not.toContain("package/private.txt");
    for (const path of ["src/.env", "src/secret.key", "docs/evidence/private.md", "docs/superpowers/private.md"])
      expect(shipped).not.toContain(`package/${path}`);
    expect(shipped).toContain("package/src/.env.example");
    for (const path of ["src/tracked.ts", "docs/tracked.md", "bun.lock", "bin/orbit", "bin/orbit.cmd", "install.cmd"])
      expect(await run(["tar", "xOf", archive, `package/${path}`], fixture))
        .toBe(await Bun.file(join(source, path)).text());
    const unpacked = join(fixture, "unpacked");
    await mkdir(unpacked);
    await run(["tar", "xzf", archive, "-C", unpacked], fixture);
    // Windows has no POSIX executable permission bits; the shell entry point still ships there.
    if (process.platform !== "win32")
      expect((await stat(join(unpacked, "package/bin/orbit"))).mode & 0o111).toBe(0o111);
    expect((await run(["git", "ls-files", "--others", "--exclude-standard", "-z"], source))
      .split("\0").filter(Boolean).sort()).toEqual(["docs/untracked.md", "src/untracked.ts"]);
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 60_000);

// This fixture requires both Git and permission to create symlinks on the host.
(Bun.which("git") && symlinkCapable ? test : test.skip)(
  "registry packaging refuses a tracked file replaced by a symlink outside the source", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orbit-pack-symlink-"));
  const source = join(fixture, "source");
  const destination = join(fixture, "archives");
  try {
    await mkdir(join(source, "src"), { recursive: true });
    await run(["git", "init", "--quiet"], source);
    await Bun.write(join(source, "package.json"), JSON.stringify({ name: "orbit-pack-symlink",
      version: "1.0.0", files: ["src", "bun.lock"] }));
    await Bun.write(join(source, "bun.lock"), await Bun.file(join(project, "bun.lock")).text());
    const tracked = join(source, "src/tracked.ts");
    await Bun.write(tracked, "tracked bytes\n");
    await run(["git", "add", "."], source);
    const outside = join(fixture, "outside.ts");
    await Bun.write(outside, "outside bytes must not ship\n");
    await rm(tracked);
    await symlink(outside, tracked);
    await expect(registryPackage(destination, source)).rejects
      .toThrow("Registry packaging refuses tracked symlink: src/tracked.ts");
    // Replacing a parent directory must be refused too, even when its file is ordinary.
    await rm(join(source, "src"), { recursive: true });
    const outsideDirectory = join(fixture, "outside");
    await mkdir(outsideDirectory);
    await Bun.write(join(outsideDirectory, "tracked.ts"), "outside directory bytes\n");
    await symlink(outsideDirectory, join(source, "src"), process.platform === "win32" ? "junction" : "dir");
    await expect(registryPackage(destination, source)).rejects
      .toThrow("Registry packaging refuses tracked symlink: src/tracked.ts");
    expect(await Bun.file(outside).text()).toBe("outside bytes must not ship\n");
    expect(await readdir(fixture)).not.toContain("archives");
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 60_000);

needsGitCheckout("git ls-files, which needs the repository and not just the binary")("the registry tarball carries tracked source and nothing the working tree happened to leave behind", async () => {
  const destination = await mkdtemp(join(tmpdir(), "orbit-pack-"));
  try {
    await run([process.execPath, "scripts/registry-package.ts", destination], project);
    // Read with readdir rather than shelling out to `bash -c ls`: a glob is not worth a shell, and
    // the shell was the only reason this test needed one at all.
    const packed = (await readdir(destination)).filter(entry => entry.endsWith(".tgz"));
    expect(packed.length).toBe(1);
    const archive = join(destination, packed[0]!);
    const shipped = (await run(["tar", "tzf", archive], destination)).split(/\r?\n/)
      .filter(Boolean).map(entry => entry.replace(/^package\//, "")).filter(entry => entry && !entry.endsWith("/"));
    const tracked = new Set((await run(["git", "ls-files", "-z"], project)).split("\0").filter(Boolean));

    // Build products are the ones that arrive by accident: a `.pyc` is gitignored, so seeing one here
    // means the pack read the working tree rather than the index.
    expect(shipped.filter(entry => entry.includes("__pycache__"))).toEqual([]);
    expect(shipped.filter(entry => !tracked.has(entry))).toEqual([]);
    // The three a packer adds whatever `files` says. They are tracked, so they need no exemption above,
    // and requiring them here catches a packer that stops adding them rather than excusing one that does.
    for (const required of ["package.json", "README.md", "LICENSE"]) expect(shipped).toContain(required);
    // The lockfile is what `--reinstall-deps` resolves against, so a package without it cannot honour
    // a flag its own help prints.
    expect(shipped).toContain("bun.lock");
    expect(await run(["tar", "xOf", archive, "package/bun.lock"], destination))
      .toBe(await Bun.file(join(project, "bun.lock")).text());
    // Every advertised platform needs its actual installation entry point in
    // the downloadable package, not merely in the development checkout.
    for (const required of ["install.sh", "install.cmd", "bin/sbar-orbit", "bin/sbar-orbit.cmd", "bunfig.toml"])
      expect(shipped).toContain(required);
  } finally { await rm(destination, { recursive: true, force: true }); }
}, 60_000);

test("a native build the package does not carry refuses by name rather than by a missing file", async () => {
  // The registry package ships no `experiments/`, so the bootstrap the installer spawns is not there.
  // Before this was handled, `bash` reported a path it could not open and that text became the step's
  // whole explanation, which says nothing about why the file is absent or what to do instead.
  const source = await mkdtemp(join(tmpdir(), "orbit-native-"));
  // A data home of its own, or this reads whatever the machine running the test has already built: the
  // runtime is shared between versions, so the step would answer "already built" instead of refusing.
  const dataHome = await mkdtemp(join(tmpdir(), "orbit-native-data-"));
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    const outcome = await buildNativeRuntime(source, { which: () => "/usr/bin/true" });
    expect(outcome.state).toBe("failed");
    expect(outcome.detail).toMatch(/registry|clone|repository/i);
    expect(outcome.remedies?.[0]?.id).toBe("native-bootstrap-absent");
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previousDataHome;
    await rm(source, { recursive: true, force: true });
    await rm(dataHome, { recursive: true, force: true });
  }
});

/**
 * The source release carries batch files a Windows cmd.exe can read.
 *
 * `.gitattributes` pins `*.cmd` to CRLF, but that governs CHECKOUT. `scripts/package.ts` reads raw
 * bytes from the git index, where the file is stored with LF, so the published archive shipped
 * `install.cmd` and `bin/sbar-orbit.cmd` with zero CRLF and 45 bare LF. Measured by unpacking the real
 * release on a Windows guest, not inferred.
 *
 * This is the kind of defect that never shows up where anyone looks: every git checkout gets CRLF from
 * `.gitattributes`, so every test on every machine passed while the artifact people actually download
 * was wrong. It works today only because both files avoid multi line `( )` blocks, which is one edit
 * away from breaking, and the break would be visible only to release users.
 */
needsGitCheckout("git cat-file reads the index, which is what stores LF")(
  "the source release carries batch files with Windows line endings", async () => {
  // Asked of the index directly rather than by packing: `scripts/package.ts` writes to a fixed
  // output/packages and refuses to overwrite, so packing here would either collide with a real release
  // or need a flag invented for a test. The index IS the packager's input, so this asks the same
  // question of the same bytes.
  const tracked = (await run(["git", "ls-files", "-z", "*.cmd"], project)).split("\0").filter(Boolean);
  // The release has to contain some, or this test would pass by finding nothing to check.
  expect(tracked.length).toBeGreaterThan(0);
  for (const path of tracked) {
    const staged = await run(["git", "show", `:${path}`], project);
    const bare = bareLineFeeds(staged);
    // The index stores LF, and that is expected: this is what the packager must correct on the way
    // out. Recorded as the reason the packager has a line ending step at all.
    expect(bare.length).toBeGreaterThan(0);
  }
  // And the packager's own correction, applied to those exact bytes.
  const { windowsLineEndings } = await import("../scripts/package-endings");
  for (const path of tracked) {
    const staged = await run(["git", "show", `:${path}`], project);
    const shipped = windowsLineEndings(path, Buffer.from(staged, "binary")).toString("binary");
    expect({ path, bare: bareLineFeeds(shipped).length })
      .toEqual({ path, bare: 0 });
    // Idempotent, so a file already stored with CRLF is not doubled into blank lines.
    expect(windowsLineEndings(path, Buffer.from(shipped, "binary")).toString("binary")).toBe(shipped);
  }
  // A file that is not a batch file is left exactly alone, since rewriting a shell script's endings
  // would break the shebang line on the machine that runs it.
  const shell = Buffer.from("#!/bin/sh\nexit 0\n", "binary");
  expect(windowsLineEndings("install.sh", shell).toString("binary")).toBe(shell.toString("binary"));
}, 180000);
