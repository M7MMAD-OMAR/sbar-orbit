import { createWorkspaceDirectory } from "../src/workspace-storage";
import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the /proc cgroup audit of a browser tree, which a Windows job object replaces; tests/windows-job.test.ts is its counterpart");
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { auditProcessScope } from "../src/process-scope";
import { launchChrome } from "../src/chrome";

test("owned Chrome and all sampled descendants remain in the invoking resource scope", async () => {
  const profile = await createWorkspaceDirectory("containment-test");
  const owner = await launchChrome(profile);
  try {
    for (let i = 0; i < 10; i++) {
      const { pid } = JSON.parse(await readFile(join(profile, "owner.json"), "utf8"));
      const audit = await auditProcessScope(pid);
      expect(audit.checked).toBeGreaterThan(3);
      expect(audit.escaped).toEqual([]);
      expect(await owner.page.evaluate(() => 1 + 1)).toBe(2);
      await Bun.sleep(200);
    }
  } finally { await owner.close(); }
}, 15000);
