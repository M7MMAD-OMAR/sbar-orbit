import { expect, test } from "bun:test";
import { join } from "node:path";
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
  expect(serviceSocketPath("", { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }, "win32"))
    .toBe(join("C:\\Users\\someone\\AppData\\Local", "sbar-orbit", "broker.sock"));
});

test("Linux still refuses a managed socket with no runtime directory rather than inventing one", () => {
  expect(() => serviceSocketPath("", {}, "linux")).toThrow(/XDG_RUNTIME_DIR/);
});

test("an explicit runtime directory wins on either platform", () => {
  expect(serviceSocketPath("/run/user/1000", {}, "win32")).toBe(join("/run/user/1000", "sbar-orbit", "broker.sock"));
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
