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
import { needsCommand } from "./platform-support";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { windowsChromeArguments } from "../src/windows-job";
import { darwinChromeArguments } from "../src/chrome";

// `fileURLToPath`, not `.pathname`: on Windows the pathname is `/C:/...`, with a leading slash that
// no Windows open can use. `tests/platform-support.ts` documents the same trap.
const source = await Bun.file(fileURLToPath(new URL("../src/chrome.ts", import.meta.url))).text();

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
  // The darwin list moved into `darwinChromeArguments` so a test could read it without starting a
  // browser, so this asks the function rather than the source. That is strictly stronger: a source
  // grep would still pass if the builder were left uncalled.
  expect(darwinChromeArguments("/tmp/profile", [])).toContain("--disable-crash-reporter");
});

test("the macOS list a test reads is the one the launcher passes", () => {
  // The defect `windowsChromeArguments` already records, checked for the new builder: a list that is
  // asserted somewhere nothing in production calls is a list that can drift silently. The launcher
  // must name the builder.
  const darwin = branch("owner = launchOnDarwin");
  expect(darwin).toContain("darwinChromeArguments");
  expect(darwin).not.toContain("--use-mock-keychain");
});

test("linux removes the crash handler, which it did not until this test existed", () => {
  expect(branch("owner = launchOnLinux")).toContain("--disable-crash-reporter");
});

test("no platform is left out of the crash handler rule", () => {
  // The point of this one is the SHAPE of the defect rather than any single platform: two branches
  // had the flag and documented why, the third had neither, and nothing failed. A per platform
  // assertion could be added for a new backend and forgotten in exactly the same way, so this asks
  // the question once for every branch that launches a browser.
  const missing: string[] = [];
  if (!darwinChromeArguments("/tmp/profile", []).includes("--disable-crash-reporter")) missing.push("darwin");
  if (!branch("owner = launchOnLinux").includes("--disable-crash-reporter")) missing.push("linux");
  expect(missing).toEqual([]);
  // And Windows, whose flag has the other name.
  expect(windowsChromeArguments("/tmp/profile", [], {}).some(a => a.includes("disable-crashpad"))).toBe(true);
});

// Git's ps on Windows cannot enumerate native browser processes. Use the OS process table.
needsCommand(process.platform === "win32" ? "powershell.exe" : "ps",
  "the launched browser is found by its private profile in the OS process table")(
  "a launched session's browser does not name the person's own Chrome directory", async () => {
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
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    const command = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }']
      : ["ps", "-eo", "pid=,ppid=,args="];
    const result = Bun.spawnSync(command, { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const table = result.stdout.toString().split(/\r?\n/);
    const line = table.find(entry => entry.includes("--user-data-dir") && entry.includes(profile) && !entry.includes("--type="));
    expect(line).toBeDefined();
    const argv = line!.trim();
    expect(argv).toContain(process.platform === "win32" ? "--disable-crashpad" : "--disable-crash-reporter");
    // And the consequence, stated directly: nothing in the command line names the person's own
    // browser directory.
    expect(argv.includes(".config/google-chrome")).toBe(false);
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      for (const brand of ["Google/Chrome", "Microsoft/Edge"]) {
        expect(argv.toLowerCase()).not.toContain(join(process.env.LOCALAPPDATA, brand, "User Data").toLowerCase());
      }
    }

    // THE HALF THIS TEST USED TO MISS, and it is the half that mattered. Asserting the browser's own
    // argv proved nothing about the CHILD it starts: Chrome 152 starts crashpad_handler regardless
    // of --disable-crash-reporter, and the handler takes its database from the user config
    // directory, not from --user-data-dir. So the flag was present, this test was green, and two
    // live handlers were writing into the person's own ~/.config/google-chrome/Crash Reports.
    //
    // The handler carries no --user-data-dir, so it cannot be found the way the browser is: a `ps`
    // filter on the profile path returns zero handlers and reads as a clean result. It is found by
    // PARENTAGE instead, which is how the adversarial suite caught this.
    const pid = argv.split(/\s+/)[0]!;
    const handlers = table
      .map(entry => entry.trim().split(/\s+/))
      .filter(fields => fields[1] === pid && /crashpad[_-]handler/.test(fields.slice(2).join(" ")))
      .map(fields => fields.join(" "));
    for (const handler of handlers) {
      expect(handler).not.toContain(join(homedir(), ".config/google-chrome"));
      // Positively, not just by absence: where a handler runs at all, its database belongs inside
      // the session's own profile, which is what XDG_CONFIG_HOME redirection achieves.
      expect(handler).toContain(profile);
    }
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  }
}, 60_000);
