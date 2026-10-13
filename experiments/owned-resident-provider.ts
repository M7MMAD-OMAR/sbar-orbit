import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";

// This explicit command admits actual platform APIs; unsupported admission fails, never passes/skips.
if (process.env.ORBIT_TEST_RESIDENT_PROVIDER !== "1") throw new Error("Explicit owned resident provider admission required");
if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Actual Windows or macOS provider required");
const root = await createWorkspaceDirectory("resident-provider");
const profile = join(root, "browser"); await mkdir(profile, { mode: 0o700 });
const browser = await launchChrome(profile);
try {
  if (!browser.sampleResidentProcesses) throw new Error("Owned platform resident callback missing");
  const live = [];
  for (let i = 0; i < 3; i++) {
    const sample = await browser.sampleResidentProcesses();
    if (!sample.pids.length || !Number.isFinite(sample.rssKiB) || sample.rssKiB <= 0)
      throw new Error("Actual owned provider resident sample is empty or invalid");
    live.push(sample); await Bun.sleep(100);
  }
  await browser.close();
  const stopped = await browser.sampleResidentProcesses();
  if (stopped.pids.length !== 0 || stopped.rssKiB !== 0) throw new Error("Actual owned provider boundary did not empty after stop");
  console.log(JSON.stringify({ residentProvider: "actual owned launch boundary", platform: process.platform,
    profileRoot: root, live, stopped, personalDesktop: "not measured" }));
} finally { await browser.close(); }
