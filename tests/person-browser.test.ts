import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchChrome } from "../src/chrome";
import { detectPlatform } from "../src/platform";

/**
 * The other guarantee this project is judged on: an agent does not touch the person's own browser.
 *
 * Reaping has its own suite. This is the opposite direction, and Windows carries a hazard Linux does
 * not. A Chromium launch normally HANDS OFF to an already running instance of the same browser
 * through its singleton, and the launching process then exits. If that happened here, Orbit would be
 * driving the person's browser, with the person's profile, cookies and windows, while reporting a
 * perfectly healthy session. The person's own Edge is running in nearly every real Windows session,
 * so this is the ordinary case rather than an edge case.
 *
 * `--user-data-dir` is what prevents it, since the singleton is per user data directory. That is a
 * one-line argument carrying a whole guarantee, which is exactly the kind of thing that should have a
 * test standing over it rather than a comment.
 *
 * Measured on a Windows 11 guest with a real second browser running: Orbit took 12 processes of its
 * own, reused none of the person's 14, stayed headless, never named their profile, and left all 14
 * plus their window alive. See docs/windows-measured.md section 17.
 */

const rows = () => {
  const command = process.platform === "win32"
    ? ["powershell", "-NoProfile", "-Command",
       "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"]
    : ["bash", "-lc", "ps -eo pid=,args= | grep -E 'chrome|chromium|msedge' | grep -v grep || true"];
  const listed = Bun.spawnSync(command).stdout.toString().trim();
  return listed ? listed.split(/\r?\n/).filter(Boolean) : [];
};

const pidOf = (row: string) => Number(process.platform === "win32" ? row.split("|")[0] : row.trim().split(/\s+/)[0]);

const supported = (await detectPlatform()).browserBackendSupported;

test.skipIf(!supported)("an owned browser is its own, and the person's browser is left alone", async () => {
  // A stand-in for the person's browser: a second browser, in a profile that is not Orbit's, already
  // running before Orbit launches. On Windows this is the process a handoff would join.
  const theirProfile = await mkdtemp(join(tmpdir(), "orbit-person-"));
  const ourProfile = await mkdtemp(join(tmpdir(), "orbit-own-"));
  let theirs: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let ours: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    theirs = await launchChrome(theirProfile);
    const before = new Set(rows().filter(row => row.includes(theirProfile)).map(pidOf));
    expect(before.size).toBeGreaterThan(0);

    ours = await launchChrome(ourProfile);
    const after = rows();
    const mine = after.filter(row => row.includes(ourProfile));

    // A handoff would leave zero processes in Orbit's own profile while still returning a usable
    // looking handle, so this is the assertion that catches it.
    expect(mine.length).toBeGreaterThan(0);
    // And none of them may be a process the other browser was already running.
    expect(mine.map(pidOf).filter(pid => before.has(pid))).toEqual([]);
    // The other browser is untouched: every process it had is still there.
    expect([...before].filter(pid => !after.map(pidOf).includes(pid))).toEqual([]);
    // Orbit's browser never names a profile that is not its own.
    expect(mine.some(row => row.includes(theirProfile))).toBe(false);

    // It also has to actually work while the other browser runs: a singleton collision shows up as a
    // session that never becomes usable rather than as an error.
    await ours.page.goto("about:blank");
    expect(await ours.page.title()).toBeDefined();

    await ours.close();
    ours = undefined;
    // Closing Orbit's browser takes Orbit's processes and nobody else's.
    const closed = rows();
    expect(closed.filter(row => row.includes(ourProfile))).toEqual([]);
    expect([...before].filter(pid => !closed.map(pidOf).includes(pid))).toEqual([]);
  } finally {
    await ours?.close().catch(() => {});
    await theirs?.close().catch(() => {});
    await rm(theirProfile, { recursive: true, force: true }).catch(() => {});
    await rm(ourProfile, { recursive: true, force: true }).catch(() => {});
  }
}, 120000);
