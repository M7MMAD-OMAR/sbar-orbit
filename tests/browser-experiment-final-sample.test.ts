import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const fixturePlatform of ["linux", "darwin", "win32"]) {
test(`final RSS outcome controls use isolated ${fixturePlatform} branch`, async () => {
  const child = Bun.spawn([process.execPath, "test", "./tests/browser-experiment-final-sample-controlled-child.ts"], {
    cwd: resolve(import.meta.dir, ".."), env: { ...process.env, ORBIT_TEST_NATIVE: "0", ORBIT_CONTROLLED_RSS_PLATFORM: fixturePlatform,
      ORBIT_BROWSER_EXPERIMENT_OUTPUT: "latest.json" },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 35000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    console.log(JSON.stringify({ finalSampleChild: { fixturePlatform, evidence: "controlled outcome, not a provider measurement", exit, raw: stdout + stderr } }));
    expect(exit).toBe(0);
    expect(stdout + stderr).toMatch(/\n\s*2 pass\s*\n/);
    expect(stdout + stderr).toMatch(/\n\s*0 fail\s*\n/);
    expect(stdout + stderr).toMatch(/Ran 2 tests across (?:1|2) files?/);
    expect(stdout + stderr).not.toMatch(/RESOURCE_LIMIT_REQUIRED|No tests found|Cannot find module/);
  } finally { clearTimeout(timer); }
}, 45000);
}
