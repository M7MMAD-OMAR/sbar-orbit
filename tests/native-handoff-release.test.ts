import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireOwnerHandoff } from "../src/native-handoff-release";

test("owner handoff stays held without valid release evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-handoff-release-"));
  try {
    expect(() => requireOwnerHandoff(join(root, "missing.json"))).toThrow(/disabled after a compositor crash/);
    for (const record of [{}, { schema: 1, state: "not measured", plugin: { source_sha256: "a".repeat(64) }, hyprland: { abi_hash: "x" } },
      { schema: 1, state: "passed", plugin: { source_sha256: "short" }, hyprland: { abi_hash: "x" } }]) {
      const path = join(root, "record.json");
      await writeFile(path, JSON.stringify(record));
      expect(() => requireOwnerHandoff(path)).toThrow(/disabled after a compositor crash/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner handoff is released by the committed nested lab evidence", () => {
  expect(() => requireOwnerHandoff()).not.toThrow();
});

(process.platform === "linux" ? test : test.skip)("Python owner paths bind the exact evidenced plugin and compositor build", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_handoff_release_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
});
