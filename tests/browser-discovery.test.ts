import { expect, test } from "bun:test";
import { chromeExecutables } from "../src/runtime-paths";
import { inspectPrerequisites } from "../src/preflight";
import { detectBrowsers } from "../src/platform";

const alternateExecutables = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/lib64/chromium-browser/chromium-browser"];

for (const executable of alternateExecutables) {
  test(`Linux launcher and preflight recognize ${executable} without another browser installed`, async () => {
    expect(chromeExecutables).toContain(executable);
    const report = await inspectPrerequisites("/fixture", {
      platform: "linux", file: async path => path === executable || !/(chrom|google)/.test(path),
      module: () => true, which: () => null, userManager: async () => true,
      missingLibraries: () => [],
    });
    expect(report.checks.find(check => check.id === "chrome-or-chromium")?.available).toBe(true);
    expect(report.browserPrerequisitesFound).toBe(true);
  });
}

test("Linux browser profiles follow another user's XDG config location", async () => {
  const browsers = await detectBrowsers("/home/another person", { XDG_CONFIG_HOME: "/data/config with spaces" }, async path =>
    path === "/usr/bin/google-chrome" || path === "/usr/bin/chromium");
  expect(browsers.filter(browser => browser.packaging === "system").map(browser => browser.profileDirectory)).toEqual([
    "/data/config with spaces/google-chrome", "/data/config with spaces/chromium",
  ]);
});
