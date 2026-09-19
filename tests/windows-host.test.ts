import { expect, test } from "bun:test";
import { join, win32 } from "node:path";
import { serviceSocketPath } from "../src/service";
import { canCloneProfile, type PlatformCapabilities } from "../src/platform";
import { windowsBrowserInstalls } from "../src/runtime-paths";

/**
 * The Windows decisions that can be checked from Linux.
 *
 * Everything here is a pure function taking its platform and environment, which is deliberate: there
 * is no Windows CI in this project, so any Windows rule that can only be exercised on Windows is a
 * rule nothing checks between guest runs. What cannot be checked here, because it needs a real
 * kernel, is in `docs/windows-measured.md` with the run that produced it.
 */

test("a managed broker on Windows binds under LOCALAPPDATA, where no runtime directory exists", () => {
  // `win32.join`: built with the host's `join` this expectation carried forward slashes on Linux, so
  // the test asserted the host-bound path bug rather than catching it.
  expect(serviceSocketPath("", { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }, "win32"))
    .toBe(win32.join("C:\\Users\\someone\\AppData\\Local", "sbar-orbit", "broker.sock"));
});

test("Linux still refuses a managed socket with no runtime directory rather than inventing one", () => {
  expect(() => serviceSocketPath("", {}, "linux")).toThrow(/XDG_RUNTIME_DIR/);
});

test("an explicit runtime directory wins on either platform", () => {
  // A caller stating a path on Windows gets it joined the Windows way, which is what the product does
  // with it. The POSIX-looking input is deliberate: an explicit directory wins whatever its shape.
  expect(serviceSocketPath("/run/user/1000", {}, "win32")).toBe(win32.join("/run/user/1000", "sbar-orbit", "broker.sock"));
});

/**
 * Refused as a platform, not by accident. Before Windows browsers were reported at all this returned
 * "no detected browser install owns that profile directory", which is a different claim and would
 * have started reading like a bug the moment discovery began working.
 */
test("cloning the person's own profile is refused on Windows, by name", async () => {
  const capabilities = {
    platform: "win32", sessionType: "none", desktop: "", nativeDisplaySupported: false,
    browserBackendSupported: true, secretService: "absent", filteredBusProxy: null,
    systemdUserScopes: false, confinedEgress: false, notes: [],
    browsers: [{ id: "microsoft-edge", executable: "C:\\Edge\\msedge.exe", packaging: "system",
      profileDirectory: "C:\\Users\\someone\\AppData\\Local\\Microsoft\\Edge\\User Data",
      keyringItem: "", keyringApplication: "" }],
  } as unknown as PlatformCapabilities;
  const verdict = await canCloneProfile(capabilities.browsers[0]!.profileDirectory, capabilities, "C:\\workspace");
  expect(verdict.allowed).toBe(false);
  expect(verdict.allowed === false && verdict.reason).toContain("App Bound Encryption");
});

test("browser discovery reports nothing when no install root and no registry answers", () => {
  // The registry probe is injected rather than left to spawn `reg`. The version of this test that
  // did not inject one passed on a Linux runner because there is no `reg` there, and would have
  // FAILED on the Windows guest it claims to describe, where App Paths answers for a real browser.
  expect(windowsBrowserInstalls({ ProgramFiles: "/nonexistent", LOCALAPPDATA: "/nonexistent" }, () => undefined)).toEqual([]);
});

/**
 * App Paths is keyed by file name and both Chrome and Chromium ship `chrome.exe`, so the registry
 * cannot tell the two brandings apart. A Chrome installed outside the three install roots used to be
 * reported twice: once correctly, and once as a `chromium` install that does not exist.
 */
test("a registry answer for chrome.exe is one install, not two brandings", () => {
  const installs = windowsBrowserInstalls(
    { ProgramFiles: "/nonexistent", LOCALAPPDATA: "/nonexistent" },
    exe => exe === "chrome.exe" ? "D:\\Custom\\Chrome\\chrome.exe" : undefined);
  expect(installs.map(install => install.id)).toEqual(["google-chrome"]);
  expect(installs[0]!.executable).toBe("D:\\Custom\\Chrome\\chrome.exe");
});

test("a machine with only Edge registered reports only Edge", () => {
  const installs = windowsBrowserInstalls(
    { ProgramFiles: "/nonexistent", LOCALAPPDATA: "/nonexistent" },
    exe => exe === "msedge.exe" ? "C:\\Edge\\msedge.exe" : undefined);
  expect(installs.map(install => install.id)).toEqual(["microsoft-edge"]);
});

/**
 * The registry probe is spawned absolutely, never through PATH.
 *
 * This spawn decides which binary Orbit launches as the session browser: a `reg.exe` earlier on PATH
 * than System32 would choose the program on a machine where the agent host, not the person, set that
 * PATH. Every Linux helper in this tree is already spawned absolutely for the same reason, and this
 * one was the exception. `%SystemRoot%` rather than a literal, because Windows is not always on C:.
 *
 * Read as source, because the alternative is planting a `reg.exe` on the runner's PATH to prove it.
 */
test("the App Paths probe spawns an absolute reg.exe rather than resolving one through PATH", async () => {
  const source = await Bun.file(join(import.meta.dir, "..", "src", "runtime-paths.ts")).text();
  const probe = source.slice(source.indexOf("function registeredPath"), source.indexOf("\n}\n", source.indexOf("function registeredPath")));
  expect(probe).not.toContain('Bun.spawnSync(["reg"');
  expect(probe).toContain("SystemRoot");
  expect(probe).toContain("reg.exe");
});
