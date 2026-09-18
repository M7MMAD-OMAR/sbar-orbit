import { test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * A suite whose SUBJECT is Linux only, skipped elsewhere with the reason written down.
 *
 * This exists because of a specific way of being wrong. The guest suite reported 107 failures, then
 * 76, and reading that number as "the port is 76 problems from done" is the mistake: most of those
 * tests are not shared code failing on Windows, they are tests of features that do not exist on
 * Windows and are documented as never going to. `desktop/panel.py` is GTK. `installService()` writes
 * systemd units. `cloneProfile()` is refused on Windows by App Bound Encryption, and
 * `docs/support-tiers.md` records that as `Refused` with a primary source. A test of any of those
 * failing on Windows is the correct outcome reported as a defect.
 *
 * So the rule here is narrow, and it is the whole value of the helper: use it ONLY where the feature
 * under test is one this project has already decided does not exist on the other platform, and name
 * that decision in `reason`. Anything that merely happens to fail on Windows is a bug to fix, not a
 * suite to silence, and reaching for this helper to make a red number smaller is how a real
 * portability defect gets buried under a skip.
 *
 * Skipping rather than deleting is deliberate: the suite still runs, and still guards the feature, on
 * the platform that has it.
 */
export function linuxOnlySuite(reason: string) {
  if (!reason.trim()) throw new Error("A Linux only suite has to say why it is Linux only");
  return process.platform === "linux" ? test : test.skip;
}

/**
 * A test whose FIXTURE needs a symlink, which is a different question from the platform.
 *
 * An unelevated Windows process cannot create one without Developer Mode, so a test that builds a
 * symlink to check what Orbit does with one dies while building its fixture, before it reaches a
 * single line of product code. The product rule those tests pin is still correct on Windows, and a
 * Windows host with Developer Mode on runs them, which is why this probes rather than branching on
 * `process.platform`.
 */
export const symlinkCapable = (() => {
  const root = mkdtempSync(join(tmpdir(), "orbit-symlink-probe-"));
  try { symlinkSync(join(root, "target"), join(root, "link")); return true; }
  catch { return false; }
  finally { rmSync(root, { recursive: true, force: true }); }
})();

export function needsSymlink(reason: string) {
  if (!reason.trim()) throw new Error("A test that needs a symlink has to say what for");
  return symlinkCapable ? test : test.skip;
}

/** The same rule for a single test inside a suite that otherwise ports. */
export const linuxOnlyTest = linuxOnlySuite;

/**
 * A test that needs a command this host may not have.
 *
 * NOT the gate for anything that asks git about this tree: that is `needsGitCheckout` below, because
 * having the binary and being inside a checkout are different questions and the difference produced a
 * fake product failure once already. Use this one for a command whose mere presence is the question.
 */
export function needsCommand(command: string, reason: string) {
  if (!reason.trim()) throw new Error("A test that needs a command has to say what for");
  return Bun.which(command) ? test : test.skip;
}

/**
 * A test that needs this source tree to be a git CHECKOUT, not merely a machine that has git.
 *
 * `needsCommand("git")` is not the same question, and the difference showed up the moment git was
 * installed on the Windows guest: the suite runs there from an unpacked tarball, so `git ls-files`
 * answered `not a git repository` and the test failed as though packaging were broken. A gate that
 * checks for the binary while the test needs the repository is a gate that does not guard what it
 * claims to, and it turns an environment fact into a fake product failure.
 */
const insideCheckout = (() => {
  if (!Bun.which("git")) return false;
  // `new URL("..", import.meta.url).pathname` yields `/C:/...` on Windows, which is not a path any
  // Windows API accepts: spawning with it threw between tests rather than failing one, taking down
  // every file that imports this module. `fileURLToPath` is the conversion that knows about drives.
  const here = dirname(fileURLToPath(import.meta.url));
  const asked = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"],
    { cwd: resolve(here, ".."), stdout: "pipe", stderr: "ignore" });
  return asked.stdout.toString().trim() === "true";
})();

export function needsGitCheckout(reason: string) {
  if (!reason.trim()) throw new Error("A test that needs a git checkout has to say what for");
  return insideCheckout ? test : test.skip;
}

/**
 * Whether `target` sits on btrfs, which is what workspace snapshots need.
 *
 * One copy, because there were two byte-identical ones and the Windows port had to patch the same
 * guard into both. `findmnt` is Linux only and spawning it elsewhere throws ENOENT at module load,
 * which takes down every test in the file rather than the one that cares about snapshots: the answer
 * on any non Linux machine is simply "no btrfs".
 */
export async function onBtrfs(target: string) {
  if (process.platform !== "linux") return false;
  const probe = Bun.spawn(["/usr/bin/findmnt", "-no", "FSTYPE", "--target", target], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(probe.stdout).text()).trim() === "btrfs" && await probe.exited === 0;
}

/**
 * A loopback address a fixture server can bind on this host.
 *
 * Linux gives the whole `127.0.0.0/8` block to `lo` and any address in it binds. macOS attaches
 * only `127.0.0.1` to `lo0`, so `Bun.serve({ hostname: "127.0.0.2" })` fails there with
 * `EADDRINUSE`, which names the wrong cause: nothing is using the port, the ADDRESS does not exist
 * on this machine. Measured on a macOS runner, where it took down a whole test file before its
 * first assertion.
 *
 * A second address can be added by hand with `sudo ifconfig lo0 alias 127.0.0.2`, which is exactly
 * the kind of machine setup a test must not require, so the address is chosen instead.
 */
export const loopbackAddress = process.platform === "darwin" ? "127.0.0.1" : "127.0.0.2";

/**
 * A temporary directory whose path is already resolved through symlinks, and through 8.3 short names.
 *
 * On macOS `tmpdir()` is `/var/folders/...` and `/var` is a symlink to `/private/var`, so a fixture
 * built on the unresolved path and product code that calls `realpath` disagree about the same
 * directory. Two install tests failed on a macOS runner for exactly this: the product returned
 * `/private/var/folders/...` and the fixture expected `/var/folders/...`, which is the same place.
 *
 * Windows has the same shape of problem for a different reason, and it needs a different call.
 * Measured on the guest with a test account whose name is nine characters, written here as <user>
 * and <SHORT~1> because a profile directory basename can be a person's name:
 *
 * ```
 * tmpdir():           <profiles>/<SHORT~1>/AppData/Local/Temp     (8.3 short form)
 * realpathSync:       <profiles>/<SHORT~1>/AppData/Local/Temp     <- unchanged
 * realpathSync.native <profiles>/<the account>/AppData/Local/Temp <- expanded
 * USERPROFILE:        <profiles>/<the account>                    (long form all along)
 * ```
 * (separators and the profile root written portably above, because a profile directory basename can
 * be a person's name and `scripts/public-audit.ts` refuses that shape in a public file)
 *
 * `%TEMP%` is handed out in the 8.3 SHORT form whenever the account name is over eight characters,
 * while `USERPROFILE` and `LOCALAPPDATA` are long, so the product reports one spelling and an
 * uncanonicalised fixture expects the other. libuv's `realpath` does NOT expand a short name; only
 * the `native` variant, which calls `GetFinalPathNameByHandleW`, does. An account of eight characters
 * or fewer hides all of this, which is why it appeared only once the guest was driven by a longer
 * name.
 *
 * Resolving in the FIXTURE rather than loosening the assertion is the point. The product's
 * `realpath` is correct and is what makes an installation refuse to sit on a symlinked prefix, so a
 * test that compared loosely would stop guarding that. Linux is unaffected either way.
 */
export async function resolvedTmpdir() {
  const { realpathSync } = await import("node:fs");
  // `native` on Windows for the short name; plain elsewhere, since `native` differs from the POSIX
  // resolution in ways the macOS case above depends on not changing.
  return process.platform === "win32" ? realpathSync.native(tmpdir()) : realpathSync(tmpdir());
}

/**
 * A directory a test may create its own fixtures under, on a path this platform really has.
 *
 * `~/.cache` is a POSIX convention: on Windows it does not exist, so `mkdtemp` under it fails with
 * ENOENT before the test reaches a line of product code, which is a fixture assumption reported as a
 * portability failure. The base is created rather than assumed, and the result goes through
 * `resolvedTmpdir`'s question as well: on Windows `tmpdir()` answers with the profile's 8.3 SHORT
 * name (`<SHORT~1>`) whenever the account name is over eight characters, while Orbit reports
 * the long one, so an uncanonicalised fixture compares two spellings of one directory and fails. An
 * account of eight characters or fewer hides that completely, which is why it appeared only when the
 * guest was driven by a longer name.
 */
export async function fixtureRoot(prefix: string, base?: string) {
  const { mkdtemp, mkdir } = await import("node:fs/promises");
  const { realpathSync } = await import("node:fs");
  const expand = (path: string) => process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
  const root = base ?? await resolvedTmpdir();
  await mkdir(root, { recursive: true });
  return expand(await mkdtemp(join(expand(root), prefix)));
}
