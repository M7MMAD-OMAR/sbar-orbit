import { test, expect } from "bun:test";
import { pickBrowser, canTakeOwnProfile, viewerCommand, type HostBrowser } from "../src/host-browsers";

/**
 * The viewer never opens in the browser the person lives in.
 *
 * This is the defect the person reported from their own desktop: clicking a session card in the panel
 * opened the viewer inside their own browser. The panel's card click, its "Open the viewer" button and
 * its Settings button all end in one `preview.open` call, so one bad pick affects every one of them.
 *
 * Measured on that desktop, `listHostBrowsers()` returned, in order:
 *
 *     id=app.zen_browser.zen  appWindow=false  isDefault=true      <- the browser they use
 *     id=chromium-browser     appWindow=true   isDefault=false
 *     id=google-chrome        appWindow=true   isDefault=false
 *     id=helium               appWindow=true   isDefault=false
 *     id=microsoft-edge       appWindow=true   isDefault=false
 *
 * `pickBrowser` began with `if (chosen || !appWindow) return chosen ?? browsers[0]`, so the moment app
 * windows were off it returned `browsers[0]`, the DEFAULT, which is Zen. Four browsers that take
 * `--user-data-dir` were installed and none of them was asked.
 */

/** The desktop that produced the report, in the order the prober returned it. */
const realDesktop: HostBrowser[] = [
  { id: "app.zen_browser.zen", name: "Zen Browser", command: ["/usr/bin/flatpak", "run", "app.zen_browser.zen"], appWindow: false, isDefault: true },
  { id: "chromium-browser", name: "Chromium", command: ["/usr/bin/chromium-browser"], appWindow: true, isDefault: false },
  { id: "google-chrome", name: "Google Chrome", command: ["/usr/bin/google-chrome-stable"], appWindow: true, isDefault: false },
  { id: "microsoft-edge", name: "Microsoft Edge", command: ["/usr/bin/microsoft-edge"], appWindow: true, isDefault: false },
];

test("the person's default browser is never picked when an isolatable one exists", () => {
  // Both switch positions, because the defect only showed with app windows off and a test that only
  // checks the on position would have stayed green through the whole bug.
  for (const appWindow of [true, false]) {
    const picked = pickBrowser(realDesktop, "", appWindow);
    expect(picked).toBeDefined();
    expect(picked!.id).not.toBe("app.zen_browser.zen");
    // And what it picked must actually be able to hold a profile of Orbit's own.
    expect(canTakeOwnProfile(picked!)).toBe(true);
  }
});

test("whatever is picked is launched with a profile that is Orbit's, not the person's", () => {
  for (const appWindow of [true, false]) {
    const picked = pickBrowser(realDesktop, "", appWindow)!;
    const argv = viewerCommand(picked, "http://127.0.0.1:9/v#token", appWindow, "/state/orbit/viewer/x");
    const isolated = argv.some(arg => arg.startsWith("--user-data-dir=")) || argv.includes("--profile");
    // Without this the viewer's URL, which carries a token that can observe, drive and stop sessions,
    // lands in the profile holding the person's cookies, history and sign-ins.
    expect(isolated).toBe(true);
    expect(argv.join(" ")).toContain("/state/orbit/viewer/x");
  }
});

test("an explicit choice is still honoured, including the default", () => {
  // Removing the ambiguity must not remove the setting: `viewerBrowser` exists so a person can say
  // which browser they want, and saying "Zen" has to mean Zen.
  expect(pickBrowser(realDesktop, "app.zen_browser.zen", true)?.id).toBe("app.zen_browser.zen");
  expect(pickBrowser(realDesktop, "microsoft-edge", false)?.id).toBe("microsoft-edge");
});

test("a Chromium default keeps its place, since preferring it costs nothing", () => {
  // The rule is not "never the default", it is "never a browser that cannot be isolated, and never a
  // Firefox-family window when a Chromium one is available". A Chromium default satisfies both.
  const chromeDefault: HostBrowser[] = [
    { id: "google-chrome", name: "Google Chrome", command: ["/usr/bin/google-chrome-stable"], appWindow: true, isDefault: true },
    { id: "microsoft-edge", name: "Microsoft Edge", command: ["/usr/bin/microsoft-edge"], appWindow: true, isDefault: false },
  ];
  expect(pickBrowser(chromeDefault, "", true)?.id).toBe("google-chrome");
  expect(pickBrowser(chromeDefault, "", false)?.id).toBe("google-chrome");
});

test("a machine with only a Firefox fork still gets a viewer, in its own profile", () => {
  // The genuine last resort the person asked for: if Orbit truly cannot do better, it opens rather
  // than refusing, because a viewer they can see beats a button that does nothing. It still gets
  // `--profile`, so it is not the profile they are signed into.
  const onlyZen: HostBrowser[] = [realDesktop[0]!];
  const picked = pickBrowser(onlyZen, "", true);
  expect(picked?.id).toBe("app.zen_browser.zen");
  expect(canTakeOwnProfile(picked!)).toBe(true);
  expect(viewerCommand(picked!, "http://127.0.0.1:9/v", true, "/state/x")).toContain("--profile");
});

test("a browser no family recognises cannot hold the viewer's token", () => {
  // No `--user-data-dir`, no `--profile`, nothing: opening the viewer in it means opening it in
  // whatever profile that browser already has. `openViewer` refuses this case rather than leaking the
  // token into it.
  const unknown: HostBrowser = { id: "some-kiosk", name: "Kiosk", command: ["/usr/bin/kiosk"], appWindow: false, isDefault: true };
  expect(canTakeOwnProfile(unknown)).toBe(false);
  expect(viewerCommand(unknown, "http://127.0.0.1:9/v", false, "/state/x")).not.toContain("--profile");
});
