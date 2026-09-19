import { test, expect } from "bun:test";
import { listHostBrowsers, viewerProfileDirectory } from "../src/host-browsers";
import { windowsBrowserInstalls } from "../src/runtime-paths";

/**
 * The viewer never opens in the person's own browser on Windows.
 *
 * This is the failure the macOS branch of `listHostBrowsers` exists to prevent, and it was live on
 * Windows for the same reason: Windows has no `.desktop` files, so the XDG scan found nothing,
 * `pickBrowser` returned undefined, and `openViewer` fell through to `fallbackCommand`, which on win32
 * is `cmd /c start`. That opens the URL with the shell's default browser association, in the profile
 * the person is logged into, and the viewer URL carries a bearer token that can observe, drive and stop
 * agent sessions. The refusal that catches this on macOS read `=== "darwin"`, so Windows was not
 * refused either: the ordinary path, on every Windows machine, not a corner case.
 *
 * These tests are host-independent on purpose. They drive the prober and the path builder with an
 * injected environment rather than requiring a Windows host, so a Linux CI run still fails if the
 * Windows branch is removed. What they cannot check from Linux is the platform dispatch inside
 * `listHostBrowsers`, which reads `process.platform` directly; that assertion is guarded below and
 * runs for real on the Windows guest.
 */

/** A Windows environment with Edge where Windows actually puts it. */
const windowsEnv = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
} as NodeJS.ProcessEnv;

test("a Windows browser list is built from the real installs, and carries a private profile", () => {
  // The prober is injected so this does not depend on a browser existing on the test host: the point
  // is the SHAPE the viewer needs, an executable it can pass `--user-data-dir` to.
  const installs = windowsBrowserInstalls(windowsEnv, exe => `C:\\Program Files\\Probed\\${exe}`);
  expect(installs.length).toBeGreaterThan(0);

  for (const install of installs) {
    // Every install must name an executable. If the viewer gets no executable it has nothing to give a
    // private profile to, which is exactly how the fallback got reached.
    expect(install.executable).toMatch(/\.exe$/i);
    // And the profile the viewer uses must never be the person's own browser profile, which is the
    // other field this same record carries.
    const viewerProfile = viewerProfileDirectory({ id: install.id }, windowsEnv, "win32");
    expect(viewerProfile).not.toBe(install.profileDirectory);
    expect(viewerProfile.toLowerCase()).not.toContain("user data");
    // It belongs under Orbit's own per platform state directory, not a POSIX path invented here.
    expect(viewerProfile).toContain("sbar-orbit");
    expect(viewerProfile).toContain("viewer");
  }
});

test("the viewer profile follows the platform's own state location, not a POSIX path", () => {
  // Built by hand this was `~/.local/state` on every platform, so on Windows the viewer's profile
  // landed at a POSIX path under the home directory: not where Windows keeps such a thing, and outside
  // the inherited ACL that protects the rest of Orbit's state.
  const onWindows = viewerProfileDirectory({ id: "microsoft-edge" }, windowsEnv, "win32");
  expect(onWindows).toContain("AppData");
  expect(onWindows).not.toContain(".local/state");

  // An explicit XDG_STATE_HOME still wins, which is what keeps the Linux behaviour unchanged.
  const explicit = viewerProfileDirectory({ id: "chromium" }, { XDG_STATE_HOME: "/data/state" } as NodeJS.ProcessEnv, "linux");
  expect(explicit).toContain("/data/state");
});

// Only meaningful on the Windows guest: `listHostBrowsers` branches on `process.platform` itself, so a
// Linux run cannot reach the Windows arm. Skipped loudly rather than passing vacuously.
test.skipIf(process.platform !== "win32")("on Windows the host browser list is never empty when a browser is installed", async () => {
  const browsers = await listHostBrowsers();
  const installs = windowsBrowserInstalls();
  // If Windows has a Chromium family browser, the viewer must see it. An empty list here IS the defect:
  // it is what sent the viewer to `cmd /c start` and the person's own profile.
  if (installs.length > 0) {
    expect(browsers.length).toBeGreaterThan(0);
    for (const browser of browsers) {
      expect(browser.command.length).toBeGreaterThan(0);
      // `appWindow` true is what makes the viewer a window of its own rather than a tab in something.
      expect(browser.appWindow).toBe(true);
    }
  }
});
