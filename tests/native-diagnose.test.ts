import { expect, test } from "bun:test";
import { join } from "node:path";

for (const name of ["native_diagnose_test.py", "native_worker_startup_test.py"]) {
  test.skipIf(process.platform !== "linux")(`${name} passes`, async () => {
    const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor", name)], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
    expect(stderr).toContain("OK");
  }, 30_000);
}
