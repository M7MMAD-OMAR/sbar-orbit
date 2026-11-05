import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanWorkspaces, markWorkspaceOwner } from "../src/workspace-storage";

type Sweep = typeof cleanWorkspaces;
async function fixture() {
  const prefix = "orbit-live-workspace-owner-";
  const created = await mkdtemp(join(tmpdir(), prefix));
  const base = await realpath(created), parent = await realpath(dirname(created));
  const close = async () => {
    const info = await lstat(base);
    if (dirname(base) !== parent || !basename(base).startsWith(prefix)
        || await realpath(base) !== base || !info.isDirectory() || info.isSymbolicLink())
      throw new Error("Refusing cleanup outside the exact owned liveness fixture");
    await rm(base, { recursive: true, force: true });
  };
  const root = join(base, "workspaces"), outside = join(base, "unrelated-owned-fixture");
  try {
    await mkdir(root, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "keep.txt"), "unrelated fixture survives");
  } catch (error) { await close(); throw error; }
  const workspace = async (name: string) => {
    const directory = join(root, name);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "payload.txt"), "owned workspace data survives");
    return directory;
  };
  const age = async (directory: string) => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(directory, old, old);
  };
  return { base, root, outside, workspace, age, socket: join(base, "nonexistent-broker.sock"),
    close };
}

test("live recorded PID preserves aged workspace even when the broker probe would say false", async () => {
  const state = await fixture();
  try {
    const directory = await state.workspace("live-owner");
    await markWorkspaceOwner(directory, state.socket, process.pid);
    const owner = await readFile(join(directory, "owner.json"), "utf8");
    await state.age(directory);
    let probes = 0;
    const result = await cleanWorkspaces(state.root, async () => { probes++; return false; });
    expect(result).toEqual({ root: state.root, removed: [], kept: ["live-owner"], refused: [] });
    expect(probes).toBe(0);
    expect(await readFile(join(directory, "payload.txt"), "utf8")).toBe("owned workspace data survives");
    expect(await readFile(join(directory, "owner.json"), "utf8")).toBe(owner);
    expect(await readFile(join(state.outside, "keep.txt"), "utf8")).toBe("unrelated fixture survives");
  } finally { await state.close(); }
});

test("live recorded PID never invokes a throwing unresponsive socket probe", async () => {
  const state = await fixture();
  try {
    const directory = await state.workspace("unresponsive-owner");
    await markWorkspaceOwner(directory, state.socket, process.pid);
    await state.age(directory);
    let probes = 0;
    const result = await cleanWorkspaces(state.root, async () => { probes++; throw new Error("owned fixture probe must not run"); });
    expect(probes).toBe(0);
    expect(result).toMatchObject({ removed: [], kept: ["unresponsive-owner"], refused: [] });
    expect(await readFile(join(directory, "payload.txt"), "utf8")).toBe("owned workspace data survives");
  } finally { await state.close(); }
});

test("a live PID veto precedes malformed or missing socket metadata", async () => {
  const state = await fixture();
  try {
    const names = ["missing-socket", "relative-socket", "nonstring-socket"];
    const sockets = [undefined, "relative.sock", 42];
    for (let index = 0; index < names.length; index++) {
      const directory = await state.workspace(names[index]!);
      await writeFile(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, socket: sockets[index] }), { mode: 0o600 });
      await state.age(directory);
    }
    let probes = 0;
    const result = await cleanWorkspaces(state.root, async () => { probes++; return false; });
    expect(probes).toBe(0);
    expect(result).toMatchObject({ removed: [], kept: [...names].sort(), refused: [] });
    for (const name of names) expect(await readFile(join(state.root, name, "payload.txt"), "utf8")).toBe("owned workspace data survives");
  } finally { await state.close(); }
});

test("malformed JSON and null recent owner markers do not throw or claim liveness proof", async () => {
  const state = await fixture();
  try {
    for (const [name, value] of [["invalid-json", "{"], ["null-owner", "null"], ["primitive-owner", '"not-an-owner"']] as const) {
      const directory = await state.workspace(name);
      await writeFile(join(directory, "owner.json"), value);
    }
    let probes = 0;
    const result = await cleanWorkspaces(state.root, async () => { probes++; return false; });
    expect(probes).toBe(0);
    expect(result).toMatchObject({ removed: [], kept: ["invalid-json", "null-owner", "primitive-owner"], refused: [] });
    // Existing recent-record grace is not an owner/descendant drain receipt.
  } finally { await state.close(); }
});

test("live-owner preservation leaves the prior unmarked-fixture cleanup policy and unrelated paths unchanged", async () => {
  const state = await fixture();
  try {
    const live = await state.workspace("live"), old = await state.workspace("old-unmarked");
    await markWorkspaceOwner(live, state.socket, process.pid);
    await state.age(live); await state.age(old);
    await writeFile(join(state.root, "regular-sibling.txt"), "leave root file alone");
    const result = await cleanWorkspaces(state.root, async () => { throw new Error("no owner probe expected"); });
    expect(result).toMatchObject({ removed: ["old-unmarked"], kept: ["live"], refused: [] });
    expect(await readFile(join(live, "payload.txt"), "utf8")).toBe("owned workspace data survives");
    expect(await readFile(join(state.root, "regular-sibling.txt"), "utf8")).toBe("leave root file alone");
    expect(await readFile(join(state.outside, "keep.txt"), "utf8")).toBe("unrelated fixture survives");
    // No guarantee is added for unmarked, invalid-PID or ESRCH workspaces.
  } finally { await state.close(); }
});

test("isolated liveness errors and ESRCH fallback expose exact keep and legacy deletion policy", async () => {
  for (const mode of ["EPERM", "unknown", "ESRCH", "ESRCH-throw", "ESRCH-false"] as const) {
    const state = await fixture();
    try {
      const directory = await state.workspace("uncertain-owner");
      await markWorkspaceOwner(directory, state.socket, process.pid);
      await state.age(directory);
      const shim = join(state.base, "local-process.mjs"), copy = join(state.base, "storage-copy.mjs");
      await writeFile(shim, [
        "export const calls = [];",
        "export const process = { kill(pid, signal) {",
        "  calls.push([pid, signal]);",
        mode === "unknown" ? "  throw null;" : "  throw Object.assign(new Error('owned fixture denial'), {code:" + JSON.stringify(mode.startsWith("ESRCH") ? "ESRCH" : mode) + "});",
        "} };",
      ].join("\n"), { mode: 0o600 });
      const source = await readFile(join(import.meta.dir, "../src/workspace-storage.ts"), "utf8");
      const needle = 'from "./errors"';
      expect(source.split(needle)).toHaveLength(2);
      const isolated = source.replace(needle, "from " + JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/errors.ts")).href));
      const injected = "import { process } from " + JSON.stringify(pathToFileURL(shim).href) + ";\n" + isolated;
      await writeFile(copy, new Bun.Transpiler({ loader: "ts" }).transformSync(injected), { mode: 0o600 });
      const module = await import(pathToFileURL(copy).href) as { cleanWorkspaces: Sweep };
      const hooks = await import(pathToFileURL(shim).href) as { calls: [number, number][] };
      let probes = 0;
      const result = await module.cleanWorkspaces(state.root, async () => {
        probes++;
        if (mode === "ESRCH-throw") throw new Error("owned fixture socket uncertainty");
        return mode === "ESRCH";
      });
      expect(hooks.calls).toEqual([[process.pid, 0]]);
      expect(probes).toBe(mode.startsWith("ESRCH") ? 1 : 0);
      if (mode === "ESRCH-false") {
        expect(result).toMatchObject({ removed: ["uncertain-owner"], kept: [], refused: [] });
        await expect(readFile(join(directory, "payload.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result).toMatchObject({ removed: [], kept: ["uncertain-owner"], refused: [] });
        expect(await readFile(join(directory, "payload.txt"), "utf8")).toBe("owned workspace data survives");
      }
      // This transformed-copy evidence does not qualify historical identity,
      // OS EPERM or descendant drain; ESRCH plus false still uses legacy deletion.
    } finally { await state.close(); }
  }
});


test("invalid present PID values preserve without coercion or any liveness/socket probe", async () => {
  const state = await fixture();
  try {
    const values = [0, -1, 2147483648, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1.5, "123", null, false, {}];
    for (let index = 0; index < values.length; index++) {
      const directory = await state.workspace("invalid-" + String(index).padStart(2, "0"));
      await writeFile(join(directory, "owner.json"), JSON.stringify({ pid: values[index], socket: state.socket }));
      await state.age(directory);
    }
    const shim = join(state.base, "never-signal.mjs"), copy = join(state.base, "invalid-pid-copy.mjs");
    await writeFile(shim, "export const calls=[]; export const process={kill(...args){calls.push(args);throw new Error('must not probe invalid PID')}};", { mode: 0o600 });
    const source = await readFile(join(import.meta.dir, "../src/workspace-storage.ts"), "utf8");
    const needle = 'from "./errors"';
    expect(source.split(needle)).toHaveLength(2);
    const isolated = source.replace(needle, "from " + JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/errors.ts")).href));
    const injected = "import { process } from " + JSON.stringify(pathToFileURL(shim).href) + ";\n" + isolated;
    await writeFile(copy, new Bun.Transpiler({ loader: "ts" }).transformSync(injected), { mode: 0o600 });
    const module = await import(pathToFileURL(copy).href) as { cleanWorkspaces: Sweep };
    const hooks = await import(pathToFileURL(shim).href) as { calls: unknown[] };
    let probes = 0;
    const result = await module.cleanWorkspaces(state.root, async () => { probes++; return false; });
    expect(hooks.calls).toEqual([]);
    expect(probes).toBe(0);
    expect(result.removed).toEqual([]);
    expect(result.kept).toHaveLength(values.length);
    expect(result.refused).toEqual([]);
    for (let index = 0; index < values.length; index++)
      expect(await readFile(join(state.root, "invalid-" + String(index).padStart(2, "0"), "payload.txt"), "utf8")).toBe("owned workspace data survives");
  } finally { await state.close(); }
});


test("missing-PID probe rejection preserves its workspace and does not abort the live-owner sweep", async () => {
  const state = await fixture();
  try {
    // Names force the missing-PID entry first, so a probe exception cannot hide
    // the later valid live owner behind an aborted sweep.
    const legacy = await state.workspace("a-legacy-missing-pid"), live = await state.workspace("z-live-owner");
    await writeFile(join(legacy, "owner.json"), JSON.stringify({ socket: state.socket }), { mode: 0o600 });
    await markWorkspaceOwner(live, state.socket, process.pid);
    const legacyOwner = await readFile(join(legacy, "owner.json"), "utf8");
    const liveOwner = await readFile(join(live, "owner.json"), "utf8");
    await state.age(legacy); await state.age(live);
    const probed: string[] = [];
    const result = await cleanWorkspaces(state.root, async socket => {
      probed.push(socket);
      throw new Error("owned fixture legacy socket result is unknown");
    });
    expect(probed).toEqual([state.socket]);
    expect(result).toEqual({ root: state.root, removed: [], kept: ["a-legacy-missing-pid", "z-live-owner"], refused: [] });
    for (const directory of [legacy, live])
      expect(await readFile(join(directory, "payload.txt"), "utf8")).toBe("owned workspace data survives");
    expect(await readFile(join(legacy, "owner.json"), "utf8")).toBe(legacyOwner);
    expect(await readFile(join(live, "owner.json"), "utf8")).toBe(liveOwner);
    expect(await readFile(join(state.outside, "keep.txt"), "utf8")).toBe("unrelated fixture survives");
  } finally { await state.close(); }
});
