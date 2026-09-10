import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auditProcessScope } from "../src/process-scope";

test("scope audit follows non-main threads and rejects an escaped descendant", async () => {
  const root = await mkdtemp("/tmp/orbit-proc-fixture-");
  await mkdir(join(root, "self")); await writeFile(join(root, "self/cgroup"), "0::/expected\n");
  for (const [pid, tids, scope] of [[42, { 42: "43", 55: "44 43 45" }, "expected"], [43, { 43: "" }, "expected"], [44, { 44: "" }, "outside"]] as const) {
    await mkdir(join(root, String(pid), "task"), { recursive: true });
    await writeFile(join(root, String(pid), "cgroup"), `0::/${scope}\n`);
    for (const [tid, children] of Object.entries(tids)) {
      await mkdir(join(root, String(pid), "task", tid)); await writeFile(join(root, String(pid), "task", tid, "children"), children);
    }
  }
  expect(await auditProcessScope(42, root)).toEqual({ checked: 3, disappearedProcesses: 1, escaped: [{ pid: 44, cgroup: "0::/outside" }] });
  await mkdir(join(root, "45", "cgroup"), { recursive: true });
  await expect(auditProcessScope(42, root)).rejects.toBeDefined();
});
