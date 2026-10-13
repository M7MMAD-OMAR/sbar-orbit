import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Each adapter owns its module registry. These controls do not measure a native provider.
for (const [file, expectedPasses] of Object.entries({ "windows-resident-controlled-child.ts": 18, "macos-resident-controlled-child.ts": 18 })) {
  test(`owned resident sampler controls: ${file}`, async () => {
    const child = Bun.spawn([process.execPath, "test", `./tests/${file}`], {
      cwd: resolve(import.meta.dir, ".."), env: { ...process.env, ORBIT_TEST_NATIVE: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      console.log(JSON.stringify({ ownedResidentControls: { file, exit, raw: stdout + stderr } }));
      expect(exit).toBe(0);
      expect(stdout + stderr).toMatch(new RegExp(`\\n\\s*${expectedPasses} pass\\s*\\n`));
      expect(stdout + stderr).toMatch(/\n\s*0 fail\s*\n/);
      expect(stdout + stderr).not.toMatch(/RESOURCE_LIMIT_REQUIRED|No tests found|Cannot find module/);
    } finally { clearTimeout(timer); }
  }, 35000);
}
