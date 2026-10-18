import { expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Controlled fixture tests the real experiment's outcome propagation only.
// No browser, compositor, screenshot or RSS measurement is claimed by these mocks.
const createTemporaryDirectory = mkdtemp;
let profileRoot = "";
let run = 0;
let launches = 0;
let cleanupB = false;
let finalFailureInjected = false;
mock.module("../src/workspace-storage", () => ({ createWorkspaceDirectory: async () => {
  run++; launches = 0; cleanupB = false; finalFailureInjected = false;
  profileRoot = await createTemporaryDirectory(join(tmpdir(), "orbit-final-sample-control-"));
  return profileRoot;
} }));
mock.module("node:fs/promises", () => ({
  mkdir: async () => {},
  readdir: async () => {
    if (run === 2 && cleanupB && !finalFailureInjected) {
      finalFailureInjected = true;
      throw new Error("controlled final proc read failure");
    }
    return ["111", "222"];
  },
  readFile: async (path: string) => path.endsWith("/cmdline")
    ? `--user-data-dir=${join(profileRoot, path.includes("/111/") ? "a" : "b")}`
    : "VmRSS: 1024",
}));
mock.module("../src/chrome", () => ({ launchChrome: async () => {
  const number = ++launches;
  let message = "";
  let saved = "";
  let result = "";
  const page = {
    goto: async () => {},
    reload: async () => { message = saved; },
    getByLabel: () => ({ fill: async (value: string) => { message = value; await Bun.sleep(12); }, inputValue: async () => message }),
    getByRole: () => ({ click: async () => { saved = message; result = `Saved: ${message}`; } }),
    locator: () => ({ textContent: async () => result }),
    screenshot: async () => {},
  };
  return { context: { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    pages: () => [page], browser: () => ({ version: () => "controlled browser, not measured" }) },
    close: async () => { if (number === 2) cleanupB = true; } };
} }));

// Import also registers the unchanged ordinary experiment case. Run1 is its
// successful controlled fixture; run2 below injects only the final RSS failure.
const { runBrowserExperiment } = await import("../experiments/browser.test");
test("final RSS sample failure rejects and persists a failed experiment report", async () => {
  expect(run).toBe(1);
  const outcome = runBrowserExperiment().then(
    () => { console.log(JSON.stringify({ finalRSSControl: { injected: finalFailureInjected, outcome: "resolved" } })); },
    error => { console.log(JSON.stringify({ finalRSSControl: { injected: finalFailureInjected, outcome: "rejected" } })); throw error; },
  );
  await expect(outcome).rejects.toThrow("Browser experiment sampling failed");
  expect(finalFailureInjected).toBe(true);
  const report = await Bun.file(new URL("../output/playwright/latest.json", import.meta.url)).json();
  expect(report.status).toBe("failed");
  expect(report.monitorErrors).toBe(1);
  expect(report.residualMatchedProcessRssKiB).toBe(2048);
});
