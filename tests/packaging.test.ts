import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNativeRuntime } from "../src/install";

/**
 * What leaves this machine for the registry. The source archive in `scripts/package.ts` is built from
 * the git index, so nothing untracked can reach it; the npm tarball is built by `bun pm pack` from the
 * working tree against the `files` list in `package.json`, which is a second path with its own rules.
 * Nothing tested it, and `0.1.0-alpha.3` shipped six `__pycache__` files because of that.
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

test("the registry tarball carries tracked source and nothing the working tree happened to leave behind", async () => {
  const destination = await mkdtemp(join(tmpdir(), "orbit-pack-"));
  try {
    await run(["bun", "pm", "pack", "--destination", destination], project);
    const archive = (await run(["bash", "-c", `ls ${JSON.stringify(destination)}/*.tgz`], destination)).trim();
    const shipped = (await run(["tar", "tzf", archive], destination)).split("\n")
      .filter(Boolean).map(entry => entry.replace(/^package\//, "")).filter(entry => !entry.endsWith("/"));
    const tracked = new Set((await run(["git", "ls-files", "-z"], project)).split("\0").filter(Boolean));

    // Build products are the ones that arrive by accident: a `.pyc` is gitignored, so seeing one here
    // means the pack read the working tree rather than the index.
    expect(shipped.filter(entry => entry.includes("__pycache__"))).toEqual([]);
    // npm adds these itself whatever `files` says, so they are shipped without being listed.
    const added = new Set(["package.json", "README.md", "LICENSE"]);
    const untracked = shipped.filter(entry => !tracked.has(entry) && !added.has(entry));
    expect(untracked).toEqual([]);
    // The lockfile is what `--reinstall-deps` resolves against, so a package without it cannot honour
    // a flag its own help prints.
    expect(shipped).toContain("bun.lock");
  } finally { await rm(destination, { recursive: true, force: true }); }
}, 60_000);

test("a native build the package does not carry refuses by name rather than by a missing file", async () => {
  // The registry package ships no `experiments/`, so the bootstrap the installer spawns is not there.
  // Before this was handled, `bash` reported a path it could not open and that text became the step's
  // whole explanation, which says nothing about why the file is absent or what to do instead.
  const source = await mkdtemp(join(tmpdir(), "orbit-native-"));
  try {
    const outcome = await buildNativeRuntime(source, { which: () => "/usr/bin/true" });
    expect(outcome.state).toBe("failed");
    expect(outcome.detail).toMatch(/registry|clone|repository/i);
    expect(outcome.remedies?.[0]?.id).toBe("native-bootstrap-absent");
  } finally { await rm(source, { recursive: true, force: true }); }
});
