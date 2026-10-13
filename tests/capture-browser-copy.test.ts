import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { needsSymlink } from "./platform-support";
import { bundleInventory, captureFactoryAdapter } from "../experiments/capture-browser-copy";

test("actual factory adapter preserves ALS-selected default args, receiver and original promise; inactive is inert", async () => {
  const state = new AsyncLocalStorage<{ executable?: string; active: boolean }>();
  const options = { extraArgs: ["--fixture"] }, lease = ["https://example.com"], owner = {};
  const egress = { tier: "in-browser", launch: { executable: "/default", args: [] } };
  const args: [string, object, object, string[], () => void, object] = ["owned fixture", {}, options, lease, () => {}, egress];
  const actual = Promise.resolve(Symbol("actual promise value"));
  const calls: unknown[][] = []; let observations = 0, refusals = 0;
  const adapter = captureFactoryAdapter<object, typeof args, symbol, { executable?: string; active: boolean }>(
    function(this: object, ...received) { expect(this).toBe(owner); calls.push(received); return actual; },
    () => { const current = state.getStore(); return current?.active ? current : undefined; },
    current => current.executable, promise => { observations++; return promise; }, () => { refusals++; });
  const selected = state.run({ executable: "/copy", active: true }, () => adapter.apply(owner, args));
  expect(selected).toBe(actual); await selected;
  expect(calls[0]?.[2]).toEqual({ ...options, executable: "/copy" });
  expect(calls[0]?.[3]).toBe(lease); expect(calls[0]?.[4]).toBe(args[4]); expect(calls[0]?.[5]).toBe(egress);
  expect(args[2]).toBe(options); expect(observations).toBe(1);
  expect(state.run({ executable: "/copy", active: false }, () => adapter.apply(owner, args))).toBe(actual);
  expect(calls[1]?.[2]).toBe(options); expect(observations).toBe(1);
  expect(adapter.apply(owner, args)).toBe(actual); expect(calls[2]?.[2]).toBe(options); expect(refusals).toBe(0);
});
test("actual factory adapter refuses explicit owners before invoke and leaves ordinary active selection unchanged", () => {
  const state = new AsyncLocalStorage<{ executable?: string }>(); let called = 0, refused = 0;
  const actual = Promise.resolve(Symbol("ordinary result"));
  const adapter = captureFactoryAdapter<object, unknown[], symbol, { executable?: string }>(
    function() { called++; return actual; }, () => state.getStore(), current => current.executable,
    promise => promise, () => { refused++; });
  for (const executable of ["/owned/browser", "", undefined])
    expect(() => state.run({ executable: "/copy" }, () => adapter.call({}, "profile", {}, { executable }))).toThrow();
  expect(() => state.run({ executable: "/copy" }, () => adapter.call({}, "profile", {}, {}, "any", () => {}, { tier: "namespace" }))).toThrow();
  expect(called).toBe(0); expect(refused).toBe(4);
  const explicit = { executable: "/owned/browser" };
  expect(state.run({}, () => adapter.call({}, "profile", {}, explicit))).toBe(actual);
  expect(called).toBe(1); expect(refused).toBe(4);
});
needsSymlink("copied app bundles contain internal relative resource links")("bundle resource inventory measures actual changed resources and internal links", async () => {
  const owner = await mkdtemp(join(tmpdir(), "orbit-copy-control-"));
  try {
    await mkdir(join(owner, "Resources")); await writeFile(join(owner, "Resources/data"), "first");
    await symlink("Resources/data", join(owner, "internal"));
    const before = await bundleInventory(owner);
    expect(before.regularFiles).toBe(1); expect(before.links).toBe(1); expect(before.bytes).toBe(5);
    expect((await bundleInventory(owner)).sha256).toBe(before.sha256);
    await writeFile(join(owner, "Resources/data"), "second");
    expect((await bundleInventory(owner)).sha256).not.toBe(before.sha256);
  } finally { await rm(owner, { recursive: true, force: true }); }
});
needsSymlink("copy admission must refuse absolute and escaping app resource links")("bundle inventory refuses absolute and escaping resource links", async () => {
  const owner = await mkdtemp(join(tmpdir(), "orbit-copy-control-"));
  try {
    await mkdir(join(owner, "bundle")); await writeFile(join(owner, "outside"), "owned control");
    await symlink("../outside", join(owner, "bundle/escape"));
    await expect(bundleInventory(join(owner, "bundle"))).rejects.toThrow();
    await rm(join(owner, "bundle/escape")); await symlink(join(owner, "outside"), join(owner, "bundle/absolute"));
    await expect(bundleInventory(join(owner, "bundle"))).rejects.toThrow();
  } finally { await rm(owner, { recursive: true, force: true }); }
});
