import { expect, test } from "bun:test";
import { join } from "node:path";

for (const fixture of ["native_a11y_refs_test.py", "native_a11y_host_test.py", "native_a11y_host_worker_test.py", "native_a11y_snapshots_test.py"]) {
  (process.platform === "linux" ? test : test.skip)(`read-only accessibility foundation: ${fixture}`, async () => {
    const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, fixture)], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
    expect(err).toContain("OK");
  }, 20000);
}
