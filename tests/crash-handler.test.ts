/**
 * The crash handler, on every platform rather than on two of three.
 *
 * Crashpad's handler calls `setsid()` in the child, so it leaves the process group AND the session:
 * `killpg` misses it, a descendant walk misses it, and it is built to outlive the browser it served.
 * `src/chrome.ts` documents that at length, twice, in the Windows branch and in the darwin branch,
 * and both pass a flag to remove it. The Linux branch named the problem in neither place and passed
 * no flag, which is how the platform this project is developed on ended up the only one that shipped
 * the escape.
 *
 * Containment is only half of the cost. The handler takes its `--database` from the browser's
 * BRANDING and not from `--user-data-dir`, so on a machine where the person has ever run Chrome, an
 * Orbit session's handler writes into `~/.config/google-chrome/Crash Reports`, which is the person's
 * own browser directory. Observed on the development host while a session ran: a live handler whose
 * argv read `--database=/home/<person>/.config/google-chrome/Crash Reports`, and the `settings.dat`
 * inside it written during the run.
 *
 * These assertions read the launch argument lists rather than timing a shared file, deliberately.
 * The first attempt at this measured the mtime of the person's `settings.dat` across a quiet window,
 * a launch without the flag and a launch with it, and ALL THREE changed, including the control that
 * launched nothing: sibling agents on this workstation were driving their own browsers into the same
 * file. A shared mutable file cannot attribute anything while anyone else is running. The arguments
 * can, with no timing at all.
 */
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsChromeArguments } from "../src/windows-job";

const source = await Bun.file(new URL("../src/chrome.ts", import.meta.url).pathname).text();

/** The argv literal each branch of launchChrome builds, read from the source of truth. */
function branch(marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("], env);", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test("windows removes the crash handler", () => {
  // Windows names it differently, and it is built by a function rather than inline, so it is asked
  // rather than read.
  expect(windowsChromeArguments("/tmp/profile", [], {}).some(a => a.includes("disable-crashpad"))).toBe(true);
});

test("macOS removes the crash handler", () => {
  expect(branch("owner = launchOnDarwin")).toContain("--disable-crash-reporter");
});

test("linux removes the crash handler, which it did not until this test existed", () => {
  expect(branch("owner = launchOnLinux")).toContain("--disable-crash-reporter");
});

test("no platform is left out of the crash handler rule", () => {
  // The point of this one is the SHAPE of the defect rather than any single platform: two branches
  // had the flag and documented why, the third had neither, and nothing failed. A per platform
  // assertion could be added for a new backend and forgotten in exactly the same way, so this asks
  // the question once for every branch that launches a browser.
  const branches = ["owner = launchOnDarwin", "owner = launchOnLinux"];
  const missing = branches.filter(marker => !branch(marker).includes("--disable-crash-reporter"));
  expect(missing).toEqual([]);
  // And Windows, whose flag has the other name.
  expect(windowsChromeArguments("/tmp/profile", [], {}).some(a => a.includes("disable-crashpad"))).toBe(true);
});

test("a launched session's browser does not name the person's own Chrome directory", async () => {
  // The end to end half, and the only one that reads a REAL process rather than the source. Not a
  // timing assertion: the launch argv is read back from the running browser, so it is attributable
  // no matter what any sibling agent is doing to the same shared files at the same time.
  const { launchChrome } = await import("../src/chrome");
  const profile = await mkdtemp(join(tmpdir(), "orbit-crash-handler-"));
  const browser = await launchChrome(profile, { width: 1280, height: 800 });
  try {
    // The owned browser exposes a Playwright context and no pid. Two earlier versions of this test
    // were green against BROKEN code because of that: the first fell back to `process.pid` and
    // asserted about `["bun", "test", ...]`, the second returned early when no pid was found, which
    // is a pass on nothing. The profile path is the identifier that actually exists, so the process
    // is found by the `--user-data-dir` it was launched with.
    const ps = Bun.spawnSync(["ps", "-eo", "pid=,args="], { stdout: "pipe" });
    const line = ps.stdout.toString().split("\n")
      .find(entry => entry.includes(`--user-data-dir=${profile}`) && !entry.includes("--type="));
    expect(line).toBeDefined();
    const argv = line!.trim();
    expect(argv).toContain("--disable-crash-reporter");
    // And the consequence, stated directly: nothing in the command line names the person's own
    // browser directory.
    expect(argv.includes(".config/google-chrome")).toBe(false);
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  }
}, 60_000);
