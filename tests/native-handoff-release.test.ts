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

test("nested lab success alone cannot release live owner handoff", () => {
  expect(() => requireOwnerHandoff()).toThrow(/disabled after a compositor crash/);
});

test("live owner release requires every measured acceptance condition", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-live-acceptance-"));
  const checks = { inputDelivered: true, selectionIsolated: true, ownerFocusPreserved: true,
    ownerPointerPreserved: true, handbackVerified: true };
  const base = { schema: 1, state: "passed", plugin: { source_sha256: "a".repeat(64) },
    hyprland: { abi_hash: "fixture-abi" } };
  const path = join(root, "record.json");
  try {
    for (const ownerAcceptance of [undefined, {}, { state: "passed", ...checks, inputDelivered: false },
      ...Object.keys(checks).map(key => ({ state: "passed", ...checks, [key]: "not measured" }))]) {
      await writeFile(path, JSON.stringify({ ...base, ownerAcceptance }));
      expect(() => requireOwnerHandoff(path)).toThrow(/disabled after a compositor crash/);
    }
    await writeFile(path, JSON.stringify({ ...base, ownerAcceptance: { state: "passed", ...checks } }));
    expect(() => requireOwnerHandoff(path)).not.toThrow();
    await writeFile(path, JSON.stringify({ ...base, plugin: { source_sha256: "z".repeat(64) },
      ownerAcceptance: { state: "passed", ...checks } }));
    expect(() => requireOwnerHandoff(path)).toThrow(/disabled after a compositor crash/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

(process.platform === "linux" ? test : test.skip)("Python owner paths bind the exact evidenced plugin and compositor build", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_handoff_release_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
});
