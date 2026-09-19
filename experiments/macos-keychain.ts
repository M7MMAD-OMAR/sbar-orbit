/**
 * Does an Orbit browser launch touch the person's `Chrome Safe Storage` Keychain item?
 *
 * The claim this measures, from `docs/support-tiers.md`, has until now been **reasoned, not
 * measured**: `components/os_crypt/keychain_password_mac.mm` looks the cookie key up with
 * `FindGenericPassword(service: "Chrome Safe Storage", account: "Chrome")`, both compile time
 * constants, so a fresh `--user-data-dir` reuses the item the person's own Chrome created, and a
 * binary that is not on that item's ACL raises a modal dialog on their screen. `--headless` does not
 * suppress it. Orbit passes `--use-mock-keychain`, documented in `os_crypt_switches.h` as existing
 * to prevent blocking dialogs, with `--password-store=basic` behind it. Correct by vendor source,
 * and never once observed.
 *
 * WHAT A GITHUB RUNNER IS, said before any number is printed. A macOS runner is a virtual Mac with
 * no person at it, no logged in Apple ID and a Keychain that is nobody's. It cannot show that no
 * modal appears on a person's real account, and nothing in this file claims that it can. What it can
 * do is take the mechanism apart:
 *
 *   A. THE ARGV, from the kernel. Not the builder's return value: `ps -o command=` on the browser
 *      process Orbit actually started, so a flag that is built and then dropped is visible.
 *   B. THE ITEM. `security find-generic-password` for `Chrome Safe Storage` before and after a
 *      launch, including its modification date, so a launch that creates or writes the item is
 *      visible.
 *   C. THE NEGATIVE CONTROL. The same browser, the same profile shape, the same argv with the two
 *      keychain flags REMOVED. A harness exits 0 for completing its steps; only the difference
 *      between these two arms says the flags do anything.
 *   D. THE HOSTILE ITEM, which is the closest a runner gets to a person's Mac. A `Chrome Safe
 *      Storage` item is planted in a throwaway keychain with an EMPTY trusted application list, so
 *      every reader is off its ACL, exactly as an Orbit launch is off the ACL of the item the
 *      person's own Chrome created. Then both arms run again against it.
 *   E. WHETHER THIS RUNNER CAN EVEN PROMPT. Before D means anything, a probe asks for the secret of
 *      an item this experiment itself created with an empty ACL, using a password it generated and
 *      never prints, and records whether the call BLOCKS (a machine that would show a dialog) or
 *      returns `errSecInteractionNotAllowed` at once (a machine that cannot). If it is the second,
 *      arm D measures "the key was asked for" and not "a dialog appeared", and the report says so
 *      in those words rather than leaving a reader to assume the stronger reading.
 *
 * Nothing here reads a person's data: every keychain item it touches is one it created, every
 * profile is a temporary directory it deletes, and the one command line it reads is Orbit's own
 * browser's, on a CI runner. No secret is printed, at any verbosity.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { darwinChromeArguments, defaultChromeExecutable, launchChrome } from "../src/chrome";
import { processGroupMembers } from "../src/macos";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ experiment: "macos-keychain", skipped: "this experiment measures the macOS Keychain", platform: process.platform }, null, 2));
  process.exit(0);
}

const SERVICE = "Chrome Safe Storage";
const ACCOUNT = "Chrome";
/** Nothing in this file waits forever. A blocked keychain call is a RESULT, so it is timed, not hung on. */
const PROMPT_TIMEOUT_MS = 20000;
const LAUNCH_TIMEOUT_MS = 60000;

type Ran = { argv: string[]; code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean };

async function run(argv: string[], timeoutMs = 15000): Promise<Ran> {
  const started = performance.now();
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timer);
  return { argv, code, stdout: stdout.trim(), stderr: stderr.trim(), ms: Math.round(performance.now() - started), timedOut };
}

/**
 * The state of the `Chrome Safe Storage` item, WITHOUT its secret.
 *
 * `security find-generic-password` with no `-g` and no `-w` prints attributes only, which is the
 * whole point: reading attributes does not consult the item's ACL, so this observation cannot itself
 * be the thing that raises a dialog. `mdat` is the modification date and is what says a launch wrote
 * to the item rather than merely finding it.
 */
async function safeStorageItem(keychain?: string) {
  const argv = ["/usr/bin/security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, ...(keychain ? [keychain] : [])];
  const found = await run(argv, 10000);
  const attribute = (name: string) => found.stdout.match(new RegExp(`"${name}"<[^>]*>=(?:0x[0-9A-F]+\\s+)?"?([^"\\n]*)"?`))?.[1] ?? null;
  return {
    present: found.code === 0,
    exitCode: found.code,
    createdAt: attribute("cdat"),
    modifiedAt: attribute("mdat"),
    // The item's own keychain path, so a reader can tell the planted item from a real one.
    keychain: found.stdout.split("\n")[0]?.trim().replace(/^keychain: /, "") ?? null,
  };
}

/** One browser launch, watched until it publishes a CDP endpoint or the deadline says it will not. */
async function launchDirectly(executable: string, profile: string, argv: string[], timeoutMs: number) {
  const started = performance.now();
  const child = Bun.spawn([executable, ...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let stderrTail = "";
  void (async () => {
    try { for await (const chunk of child.stderr) stderrTail = (stderrTail + new TextDecoder().decode(chunk)).slice(-4000); } catch {}
  })();
  let endpointMs: number | null = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      if (port && /^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) { endpointMs = Math.round(performance.now() - started); break; }
    } catch {}
    await Bun.sleep(50);
  }
  const exitedEarly = child.exitCode;
  child.kill("SIGKILL");
  await Promise.race([child.exited, Bun.sleep(5000)]);
  return {
    endpointMs,
    published: endpointMs !== null,
    exitCodeBeforeEndpoint: exitedEarly,
    // Chrome's own complaint is the other witness. Bounded and filtered to keychain related lines so
    // the report does not carry four kilobytes of unrelated logging.
    keychainStderr: stderrTail.split("\n").map(line => line.trim())
      .filter(line => /keychain|Keychain|os_crypt|OSCrypt|-25308|errSec/.test(line)).slice(-5),
  };
}

const report: Record<string, unknown> = {
  experiment: "macos-keychain",
  date: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: (await run(["/usr/bin/sw_vers"], 8000)).stdout },
};
const cleanups: (() => Promise<void>)[] = [];

try {
  const executable = defaultChromeExecutable();
  report.executable = executable ?? null;
  if (!executable) {
    report.verdict = "not measured: no Chromium family browser is installed on this host";
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  report.browserVersion = (await run([executable, "--version"], 15000)).stdout;

  // The census, before anything of this experiment's has run.
  const keychainsBefore = (await run(["/usr/bin/security", "list-keychains", "-d", "user"], 8000)).stdout;
  const originalKeychainList = keychainsBefore.split("\n").map(line => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const baselineSafeStorage = await safeStorageItem();
  report.baseline = {
    keychains: originalKeychainList,
    defaultKeychain: (await run(["/usr/bin/security", "default-keychain", "-d", "user"], 8000)).stdout.trim().replace(/^"|"$/g, ""),
    safeStorage: baselineSafeStorage,
  };

  // ---------------------------------------------------------------------------------------------
  // E. Can this runner prompt at all? Asked FIRST, because every later arm is read through it.
  // ---------------------------------------------------------------------------------------------
  const probeKeychainPath = join(await mkdtemp(join(tmpdir(), "orbit-keychain-")), "orbit-probe.keychain-db");
  // A password this process generated for a keychain it is about to delete. It is passed on a command
  // line, which on a shared machine would be visible in `ps`; this runs on a throwaway CI runner and
  // the keychain it unlocks holds nothing but items this file created. It is never printed.
  const probePassword = randomBytes(24).toString("base64url");
  await run(["/usr/bin/security", "create-keychain", "-p", probePassword, probeKeychainPath], 10000);
  cleanups.push(async () => { await run(["/usr/bin/security", "delete-keychain", probeKeychainPath], 10000); });
  // No lock on sleep and no lock on a timeout: a keychain that relocked mid experiment would produce
  // a password dialog of a different kind and confuse every reading below.
  await run(["/usr/bin/security", "set-keychain-settings", probeKeychainPath], 10000);
  await run(["/usr/bin/security", "unlock-keychain", "-p", probePassword, probeKeychainPath], 10000);

  // An item with `-T` and nothing after it: an EMPTY trusted application list, so no binary is on
  // its ACL. That is the shape of the person's real `Chrome Safe Storage` as seen by a binary that
  // did not create it, and asking for its data is the call that raises the dialog.
  const probeSecret = randomBytes(16).toString("base64");
  await run(["/usr/bin/security", "add-generic-password", "-a", "orbit-probe", "-s", "Orbit Keychain Probe",
    "-w", probeSecret, "-T", "", "-U", probeKeychainPath], 10000);
  // `-w` prints ONLY the password, so it is sent nowhere: the exit code and the elapsed time are the
  // measurement. A machine that would show a dialog blocks here until the timeout; a machine that
  // cannot show one returns 36 / errSecInteractionNotAllowed in milliseconds.
  const promptProbe = await run(["/usr/bin/security", "find-generic-password", "-w", "-a", "orbit-probe",
    "-s", "Orbit Keychain Probe", probeKeychainPath], PROMPT_TIMEOUT_MS);
  report.promptCapability = {
    question: "asked for the data of an item this experiment created with an empty ACL",
    blocked: promptProbe.timedOut,
    exitCode: promptProbe.code,
    ms: promptProbe.ms,
    // The secret itself is discarded. Only whether one came back.
    returnedSecret: !promptProbe.timedOut && promptProbe.code === 0 && promptProbe.stdout.length > 0,
    stderr: promptProbe.stderr.slice(0, 400),
    reading: promptProbe.timedOut
      ? "this host BLOCKS an off ACL read, which is the behaviour that is a modal dialog on a person's Mac"
      : promptProbe.code === 0
        ? "this host GRANTS an off ACL read without interaction, so it cannot reproduce the person's hazard at all"
        : "this host REFUSES an off ACL read without interaction, so the dialog itself is not reproducible here and the arms below measure whether the key was ASKED for, not whether a dialog appeared",
  };

  // ---------------------------------------------------------------------------------------------
  // A and B. Orbit's own launcher, and what it did to the item.
  // ---------------------------------------------------------------------------------------------
  const orbitProfile = await mkdtemp(join(tmpdir(), "orbit-keychain-session-"));
  cleanups.push(async () => { await rm(orbitProfile, { recursive: true, force: true }); });
  const orbitStarted = performance.now();
  const session = await launchChrome(orbitProfile);
  const owner = JSON.parse(await readFile(join(orbitProfile, "owner.json"), "utf8")) as { pid: number; pgid: number };
  // The argv the KERNEL has, for every process in the group, not the list the builder returned. This
  // is where a flag that is built and then dropped on the way to the process shows up.
  const group = processGroupMembers(owner.pgid);
  const commandLines: string[] = [];
  for (const pid of group.pids) {
    const ps = await run(["/bin/ps", "-p", String(pid), "-o", "command="], 8000);
    if (ps.code === 0 && ps.stdout) commandLines.push(ps.stdout);
  }
  const browserLine = commandLines.find(line => line.includes(orbitProfile) && !line.includes("--type="))
    ?? commandLines.find(line => line.includes(orbitProfile)) ?? "";
  report.orbitLaunch = {
    launchMs: Math.round(performance.now() - orbitStarted),
    processesInGroup: group.pids.length,
    // The profile path is this experiment's own temporary directory, so printing it leaks nothing.
    browserCommandLineSeen: browserLine.length > 0,
    useMockKeychainInKernelArgv: browserLine.includes("--use-mock-keychain"),
    passwordStoreBasicInKernelArgv: browserLine.includes("--password-store=basic"),
    // Every process of the tree, since a renderer or a utility process inherits the switches and a
    // missing one there would be the same defect in a different place.
    processesCarryingMockKeychain: commandLines.filter(line => line.includes("--use-mock-keychain")).length,
    processesInspected: commandLines.length,
  };
  const afterOrbit = await safeStorageItem();
  await session.close().catch(() => {});

  // ---------------------------------------------------------------------------------------------
  // C. The negative control: the same argv with the two flags removed.
  // ---------------------------------------------------------------------------------------------
  // Both arms are built by the SAME function the launcher calls, and the broken arm is that list
  // with two entries filtered out. Nothing else differs, which is what makes the difference readable.
  const common = [`--headless`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking"];
  const withFlagsFor = (profile: string) => darwinChromeArguments(profile, [`--user-data-dir=${profile}`, ...common]);
  const strip = (argv: string[]) => argv.filter(argument => argument !== "--use-mock-keychain" && argument !== "--password-store=basic");

  const arms: Record<string, unknown> = {};
  for (const [name, mutate] of [["flagged", (a: string[]) => a], ["stripped", strip]] as const) {
    const profile = await mkdtemp(join(tmpdir(), `orbit-keychain-${name}-`));
    cleanups.push(async () => { await rm(profile, { recursive: true, force: true }); });
    const before = await safeStorageItem();
    const result = await launchDirectly(executable, profile, mutate(withFlagsFor(profile)), LAUNCH_TIMEOUT_MS);
    const after = await safeStorageItem();
    arms[name] = {
      ...result,
      itemBefore: before, itemAfter: after,
      itemCreatedByThisLaunch: !before.present && after.present,
      itemModifiedByThisLaunch: before.present && after.present && before.modifiedAt !== after.modifiedAt,
      localStateBytes: await stat(join(profile, "Local State")).then(entry => entry.size).catch(() => null),
    };
  }
  report.defaultKeychainArms = arms;

  // ---------------------------------------------------------------------------------------------
  // D. The hostile item: a `Chrome Safe Storage` nothing is on the ACL of, first in the search list.
  // ---------------------------------------------------------------------------------------------
  await run(["/usr/bin/security", "add-generic-password", "-a", ACCOUNT, "-s", SERVICE,
    "-w", randomBytes(16).toString("base64"), "-T", "", "-U", probeKeychainPath], 10000);
  const listed = await run(["/usr/bin/security", "list-keychains", "-d", "user", "-s", probeKeychainPath, ...originalKeychainList], 10000);
  cleanups.push(async () => { await run(["/usr/bin/security", "list-keychains", "-d", "user", "-s", ...originalKeychainList], 10000); });
  const hostile: Record<string, unknown> = { searchListSet: listed.code === 0, plantedItem: await safeStorageItem(probeKeychainPath) };
  for (const [name, mutate] of [["flagged", (a: string[]) => a], ["stripped", strip]] as const) {
    const profile = await mkdtemp(join(tmpdir(), `orbit-keychain-hostile-${name}-`));
    cleanups.push(async () => { await rm(profile, { recursive: true, force: true }); });
    const before = await safeStorageItem(probeKeychainPath);
    const result = await launchDirectly(executable, profile, mutate(withFlagsFor(profile)), LAUNCH_TIMEOUT_MS);
    const after = await safeStorageItem(probeKeychainPath);
    hostile[name] = { ...result, itemModifiedByThisLaunch: before.modifiedAt !== after.modifiedAt, itemAfter: after };
  }
  report.hostileItemArms = hostile;

  // ---------------------------------------------------------------------------------------------
  // The verdict, written here rather than left for a reader to infer, and deliberately narrow.
  // ---------------------------------------------------------------------------------------------
  const argvOk = (report.orbitLaunch as { useMockKeychainInKernelArgv: boolean; passwordStoreBasicInKernelArgv: boolean });
  const orbitTouchedItem = baselineSafeStorage.modifiedAt !== afterOrbit.modifiedAt
    || (!baselineSafeStorage.present && afterOrbit.present);
  report.orbitLaunchTouchedSafeStorage = orbitTouchedItem;
  report.verdict = !argvOk.useMockKeychainInKernelArgv || !argvOk.passwordStoreBasicInKernelArgv
    ? "FAILED: the browser Orbit started did not carry both keychain switches in the argv the kernel reports"
    : orbitTouchedItem
      ? "FAILED: an Orbit launch created or modified the Chrome Safe Storage item"
      : "an Orbit launch on this runner carried both switches into the kernel's own view of the browser argv and left Chrome Safe Storage untouched. What no runner shows: that no modal appears on a person's real account";
  process.exitCode = String(report.verdict).startsWith("FAILED") ? 1 : 0;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.verdict = "not measured: the experiment did not complete";
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
