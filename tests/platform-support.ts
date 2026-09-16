import { test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * `git` is the case that produced it: `tests/packaging.test.ts` and `tests/public-audit.test.ts` ask
 * git what is tracked, which is the right question and unanswerable on a machine without it. A host
 * with no git should say so rather than report the project broken, and the Windows guest is exactly
 * such a host.
 */
export function needsCommand(command: string, reason: string) {
  if (!reason.trim()) throw new Error("A test that needs a command has to say what for");
  return Bun.which(command) ? test : test.skip;
}
