import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConversationUsage as ProductionUsage } from "../src/conversation-usage";

/** Report a stuck fixture, never infer cancellation or delete its in-flight files. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Owned legacy usage fixture did not settle")), 3000);
  });
  try { return await Promise.race([work, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

interface RaceHooks { blocked: Promise<string>; releaseOn(): void; events: string[] }

// Production-derived import-isolated transpiled copy, not the exact loaded
// production module or a real cross-process execution.
// Known unsafe behavior evidence, NOT the desired contract or a writer-cohort gate.
// Replace this expectation with a monotonic-off regression when the actual legacy
// ingress protocol is repaired. An in-process tail alone cannot fence old writers.
test("KNOWN UNFIXED: delayed legacy on overwrites a later completed off without a newer on request", async () => {
  const base = await mkdtemp(join(tmpdir(), "orbit-legacy-usage-race-"));
  const root = join(base, "usage"), hooksPath = join(base, "hooks.mjs"), fsPath = join(base, "owned-fs.mjs");
  const modulePath = join(base, "actual-usage.mjs"), id = "owned-overlapping-conversation";
  const final = join(root, createHash("sha256").update(id).digest("hex") + ".json");
  const operations: Promise<unknown>[] = [];
  let hooks: RaceHooks | undefined;
  try {
    // Unique module identities make this seam local to this fixture. No mock.module,
    // global filesystem patch, process environment mutation or production API change.
    await writeFile(hooksPath, [
      "let release, announce, released = false;",
      "const gate = new Promise(resolve => { release = resolve; });",
      "export const blocked = new Promise(resolve => { announce = resolve; });",
      "export const events = [];",
      "export const pauseOn = async path => { events.push('blocked:on'); announce(path); await gate; };",
      "export const releaseOn = () => { if (!released) { released = true; events.push('released:on'); release(); } };",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    const hooksUrl = pathToFileURL(hooksPath).href;
    await writeFile(fsPath, [
      "import * as real from 'node:fs/promises';",
      "import { events, pauseOn } from " + JSON.stringify(hooksUrl) + ";",
      "export const mkdir = real.mkdir, readFile = real.readFile, rm = real.rm;",
      "const modes = new Map();",
      "export const writeFile = async (path, value, options) => {",
      "  const mode = JSON.parse(value).enabled ? 'on' : 'off';",
      "  await real.writeFile(path, value, options);",
      "  modes.set(path, mode); events.push('written:' + mode);",
      "  if (mode === 'on') await pauseOn(path);",
      "};",
      "export const rename = async (from, to) => {",
      "  const mode = modes.get(from); events.push('rename:' + mode);",
      "  await real.rename(from, to); events.push('renamed:' + mode);",
      "};",
    ].join("\n"), { mode: 0o600, flag: "wx" });

    const productionPath = join(import.meta.dir, "../src/conversation-usage.ts");
    const original = await readFile(productionPath, "utf8");
    let isolated = original;
    for (const [specifier, destination] of [
      ["node:fs/promises", pathToFileURL(fsPath).href],
      ["./errors", pathToFileURL(join(import.meta.dir, "../src/errors.ts")).href],
      ["./service", pathToFileURL(join(import.meta.dir, "../src/service.ts")).href],
      ["./caller", pathToFileURL(join(import.meta.dir, "../src/caller.ts")).href],
    ] as const) {
      const needle = "from " + JSON.stringify(specifier);
      expect(isolated.split(needle)).toHaveLength(2); // Fail if a hook did not bind.
      isolated = isolated.replace(needle, "from " + JSON.stringify(destination));
    }
    const body = "export type UsageMode";
    expect(original.includes(body)).toBe(true);
    expect(isolated.slice(isolated.indexOf(body))).toBe(original.slice(original.indexOf(body)));
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(isolated);
    await writeFile(modulePath, compiled, { mode: 0o600, flag: "wx" });
    hooks = await import(hooksUrl) as RaceHooks;
    expect(hooks).toBeDefined();
    const observer = hooks!;
    const module = await import(pathToFileURL(modulePath).href) as {
      ConversationUsage: new (conversationId: string, root: string) => ProductionUsage;
    };
    const earlier = new module.ConversationUsage(id, root), later = new module.ConversationUsage(id, root);
    const requests: string[] = [];
    let earlierSettled = false;
    requests.push("on");
    const on = earlier.set("on");
    operations.push(on);
    void on.then(() => { earlierSettled = true; }, () => { earlierSettled = true; });
    const temporary = await bounded(Promise.race([
      observer.blocked,
      on.then(() => { throw new Error("Production on write did not reach the isolated barrier"); }),
    ]));
    expect(temporary.startsWith(root + sep)).toBe(true);
    expect(temporary.endsWith(".tmp")).toBe(true);
    expect(JSON.parse(await readFile(temporary, "utf8"))).toEqual({ enabled: true });
    expect(observer.events).toEqual(["written:on", "blocked:on"]);

    requests.push("off");
    const off = later.set("off");
    operations.push(off);
    expect(await bounded(off)).toEqual({ enabled: false, scope: "conversation", conversationId: id });
    expect(JSON.parse(await readFile(final, "utf8"))).toEqual({ enabled: false });
    expect(earlierSettled).toBe(false);
    expect(observer.events).toEqual(["written:on", "blocked:on", "written:off", "rename:off", "renamed:off"]);

    observer.releaseOn();
    expect(await bounded(on)).toEqual({ enabled: true, scope: "conversation", conversationId: id });
    expect(JSON.parse(await readFile(final, "utf8"))).toEqual({ enabled: true });
    expect(requests).toEqual(["on", "off"]); // No fresh on after the completed off.
    expect(observer.events).toEqual(["written:on", "blocked:on", "written:off", "rename:off", "renamed:off",
      "released:on", "rename:on", "renamed:on"]);
  } finally {
    hooks?.releaseOn();
    // No files are removed until every operation settles after the explicit release.
    // A syscall hang reports failure and retains this owned fixture, not false drain.
    await bounded(Promise.allSettled(operations));
    await rm(base, { recursive: true, force: true });
  }
}, 12000);
