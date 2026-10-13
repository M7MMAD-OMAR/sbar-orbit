import { expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Controlled fixture tests the real experiment's outcome propagation only.
// No browser, compositor, screenshot or RSS measurement is claimed by these mocks.
// The isolated child may exercise each branch with an explicit controlled platform.
const fixturePlatform = process.env.ORBIT_CONTROLLED_RSS_PLATFORM;
if (fixturePlatform) {
  if (!["linux", "darwin", "win32"].includes(fixturePlatform)) throw new Error("Invalid controlled RSS platform");
  Object.defineProperty(process, "platform", { value: fixturePlatform });
}
const createTemporaryDirectory = mkdtemp;
let profileRoot = "";
let run = 0;
let launches = 0;
let cleanupB = false;
let finalFailureInjected = false;
let procReads = 0;
mock.module("../src/workspace-storage", () => ({ createWorkspaceDirectory: async () => {
  run++; launches = 0; cleanupB = false; finalFailureInjected = false; procReads = 0;
  profileRoot = await createTemporaryDirectory(join(tmpdir(), "orbit-final-sample-control-"));
  return profileRoot;
} }));
mock.module("node:fs/promises", () => ({
  mkdir: async () => {},
  readdir: async () => {
    procReads++;
    if (process.platform !== "linux") throw new Error("Controlled non Linux provider has no /proc");
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
    sampleResidentProcesses: async () => {
      if (run === 2 && cleanupB && !finalFailureInjected) {
        finalFailureInjected = true;
        throw new Error("controlled final owned boundary RSS failure");
      }
      return { pids: [number === 1 ? 111 : 222], rssKiB: 1024,
        source: process.platform === "win32" ? "owned Windows job working set" : "owned macOS process group resident memory" };
    },
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
  if (process.platform === "linux") expect(procReads).toBeGreaterThan(0);
  else expect(procReads).toBe(0);
  const report = await Bun.file(new URL("../output/playwright/latest.json", import.meta.url)).json();
  expect(report.status).toBe("failed");
  expect(report.monitorErrors).toBe(1);
  expect(process.platform === "linux" ? report.residualMatchedProcessRssKiB : report.residualOwnedBoundaryResidentKiB).toBe(2048);
});
