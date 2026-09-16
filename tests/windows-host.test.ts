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
  // On a Linux runner every candidate path is absent, which is the same answer a bare Windows host
  // gives. What this pins is that discovery returns a list rather than throwing off its own platform.
  expect(windowsBrowserInstalls({ ProgramFiles: "/nonexistent", LOCALAPPDATA: "/nonexistent" })).toEqual([]);
});
