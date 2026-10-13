import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeAdmission } from "../experiments/browser-performance-identity";

const typedSource = "const value: number = 13; module.exports = { value };\n";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identity = (path: string, contents: string | Uint8Array) => {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  return { path, sha256: hash(bytes), bytes: bytes.length };
};
const bun = identity(process.execPath, readFileSync(process.execPath));
const wrapper = [
  "(function(exports,require,module,__filename,__dirname){return (function(exports,require,module,__filename,__dirname){",
  '\n}).call(this,exports,module[Symbol.for("orbit.performance.measured-require")],module,__filename,__dirname);\n})',
];
const wrapperBytes = Buffer.from(JSON.stringify(wrapper), "utf8");

function typedReceipt() {
  const input = identity(join(tmpdir(), "orbit-delivery-fixture", "fixture.cts"), typedSource);
  const contents = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(typedSource);
  const outputBytes = Buffer.from(contents, "utf8");
  const output = { sha256: hash(outputBytes), bytes: outputBytes.length, contents };
  const row = { ...input, loader: "ts", delivery: "commonjs-typescript-compile", completed: true,
    compilerFilename: input.path, argumentSha256: output.sha256, argumentBytes: output.bytes,
    wrapperSha256: hash(wrapperBytes), wrapperBytes: wrapperBytes.length,
    transform: { tool: "Bun.Transpiler", bun: { ...bun }, bunVersion: Bun.version, bunRevision: Bun.revision,
      options: { loader: "ts", target: "bun" }, input: { ...input }, output } };
  const browser = identity(join(tmpdir(), "orbit-delivery-fixture", "browser"), "fixture-browser");
  const shared = { bun: { ...bun }, browser, lock: identity("fixture-lock", "locked"),
    package: identity("fixture-package", "{}"), dependencies: [input], source: [] };
  const producer = { experiment: identity("fixture-experiment", "experiment"),
    identity: identity("fixture-identity", "identity"), runner: identity("fixture-runner", "runner") };
  const python = { executable: "fixture-python", sha256: "fixture-python-sha", version: "fixture",
    loadedModules: { "fixture-module.py": "fixture-module-sha" } };
  return { row, runtime: { schema: 2, failures: [] as string[], attempts: [structuredClone(row)],
    loaded: [row], loadedAfter: [{ ...input }], stable: true, entryLoaded: true, loadedStable: true,
    workerPid: 10, bunVersion: Bun.version, bunRevision: Bun.revision, entry: input.path,
    before: structuredClone(shared), after: structuredClone(shared), producer, producerAfter: structuredClone(producer) },
    tree: { worker: 10, browserIdentity: { witness: { workerPid: 10, browserVersion: "fixture" } },
      pythonBefore: python, pythonAfter: structuredClone(python), cleanup: "wait returned ECHILD",
      sampleFailures: 0, timedOut: false, exitCode: 0 },
    binaries: { bun: { ...bun }, browser, producer: structuredClone(producer),
      python: { path: python.executable, sha256: python.sha256 } }, shared };
}

test("typed admission binds original CTS input to transformed compiler argument", () => {
  const r = typedReceipt();
  expect(r.row.argumentSha256).not.toBe(r.row.sha256);
  expect(r.row.transform.input.path).toBe(r.row.compilerFilename);
  expect(runtimeAdmission(r.runtime, r.tree, r.binaries, r.shared)).toBe(true);
});

type TypedReceipt = ReturnType<typeof typedReceipt>;
const mutations: Array<[string, (r: TypedReceipt) => void]> = [
  ["missing transform", r => { Reflect.deleteProperty(r.row, "transform"); }],
  ["missing input", r => { Reflect.deleteProperty(r.row.transform, "input"); }],
  ["missing output", r => { Reflect.deleteProperty(r.row.transform, "output"); }],
  ["missing options", r => { Reflect.deleteProperty(r.row.transform, "options"); }],
  ["missing tool", r => { Reflect.deleteProperty(r.row.transform, "tool"); }],
  ["wrong tool", r => { r.row.transform.tool = "other"; }],
  ["wrong Bun pin", r => { r.row.transform.bun.sha256 = "0".repeat(64); }],
  ["wrong version", r => { r.row.transform.bunVersion = "other"; }],
  ["wrong revision", r => { r.row.transform.bunRevision = "other"; }],
  ["missing runtime revision", r => { Reflect.deleteProperty(r.runtime, "bunRevision"); Reflect.deleteProperty(r.row.transform, "bunRevision"); }],
  ["empty runtime revision", r => { r.runtime.bunRevision = ""; r.row.transform.bunRevision = ""; }],
  ["nonstring runtime revision", r => { Reflect.set(r.runtime, "bunRevision", 123); Reflect.set(r.row.transform, "bunRevision", 123); }],
  ["extra option", r => { Reflect.set(r.row.transform.options, "extra", true); }],
  ["wrong loader option", r => { r.row.transform.options.loader = "js"; }],
  ["wrong target option", r => { r.row.transform.options.target = "node"; }],
  ["wrong input path", r => { r.row.transform.input.path += ".other"; }],
  ["wrong input hash", r => { r.row.transform.input.sha256 = "0".repeat(64); }],
  ["wrong input bytes", r => { r.row.transform.input.bytes++; }],
  ["wrong output contents", r => { r.row.transform.output.contents += "\n"; }],
  ["wrong output hash", r => { r.row.transform.output.sha256 = "0".repeat(64); }],
  ["wrong output bytes", r => { r.row.transform.output.bytes++; }],
  ["wrong argument hash", r => { r.row.argumentSha256 = "0".repeat(64); }],
  ["wrong argument bytes", r => { r.row.argumentBytes++; }],
  ["wrong wrapper hash", r => { r.row.wrapperSha256 = "0".repeat(64); }],
  ["wrong wrapper bytes", r => { r.row.wrapperBytes++; }],
  ["wrong suffix", r => {
    const path = r.row.path.replace(/\.cts$/, ".ts");
    r.row.path = path; r.row.compilerFilename = path; r.row.transform.input.path = path;
    r.runtime.entry = path;
    const pin = { path, sha256: r.row.sha256, bytes: r.row.bytes };
    r.shared.dependencies = [pin]; r.runtime.before = structuredClone(r.shared);
    r.runtime.after = structuredClone(r.shared); r.runtime.loadedAfter = [pin];
  }],
  ["wrong row loader", r => { r.row.loader = "js"; }],
  ["unknown delivery", r => { r.row.delivery = "unknown"; }],
  ["wrong compiler filename", r => { r.row.compilerFilename += ".other"; }],
];
for (const [name, mutate] of mutations) test(`typed admission rejects ${name}`, () => {
  const r = typedReceipt(); mutate(r);
  // Keep attempts and loaded equal so rejection tests the altered proof, not history drift.
  r.runtime.attempts = [structuredClone(r.row)];
  expect(runtimeAdmission(r.runtime, r.tree, r.binaries, r.shared)).toBe(false);
});

async function executeFixture(kind: "cts" | "json" | "escape" | "snapshot-escape") {
  const rawRoot = await mkdtemp(join(tmpdir(), "orbit-delivery-regression-"));
  const root = await realpath(rawRoot);
  const outside = `${root}-outside.js`;
  try {
    for (const directory of ["experiments", "scripts", "src", "node_modules/playwright"])
      await mkdir(join(root, directory), { recursive: true });
    const source = await readFile(new URL("../experiments/browser-performance-identity.ts", import.meta.url));
    await writeFile(join(root, "experiments/browser-performance-identity.ts"), source);
    await writeFile(join(root, "experiments/browser-performance.ts"), "export {};\n");
    await writeFile(join(root, "scripts/limited.ts"), "export {};\n");
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(join(root, "bun.lock"), "fixture-lock\n");
    await writeFile(join(root, "src/fixture.cts"), typedSource);
    await writeFile(join(root, "src/data.json"), '{"value":41}\n');
    await writeFile(join(root, "node_modules/playwright/package.json"), '{"type":"module","main":"index.js"}\n');
    await writeFile(join(root, "node_modules/playwright/index.js"), kind === "cts"
      ? 'import value from "../../src/fixture.cts"; export const actual=value.value;\n'
      : 'import value from "../../src/data.json"; export const actual=value.value;\n');
    const regularDriver = [
      'import {beginRuntimeIdentity,sharedRuntimeSnapshot} from "./browser-performance-identity";',
      'const shared=await sharedRuntimeSnapshot(process.execPath);',
      'const measurement=await beginRuntimeIdentity(process.execPath,shared);',
      'const imported=await import("playwright");',
      'console.log(JSON.stringify({actual:imported.actual,receipt:await measurement.finish()}));',
    ].join("\n");
    const escapeDriver = [
      'import {beginRuntimeIdentity,sharedRuntimeSnapshot} from "./browser-performance-identity";',
      'import {writeFile,symlink,lstat,readlink,realpath,unlink} from "node:fs/promises";',
      'import {strict as assert} from "node:assert";',
      `const target=${JSON.stringify(join(root, "src/escaped.js"))};`,
      `const outside=${JSON.stringify(outside)};`,
      'const shared=await sharedRuntimeSnapshot(process.execPath);',
      'const measurement=await beginRuntimeIdentity(process.execPath,shared);',
      'await writeFile(outside,"globalThis.__orbit_escape_executed=true; export const value=13;\\n");',
      'await symlink(outside,target);',
      'let error; try {await import(target);} catch(held) {error=String(held);}',
      'assert(error?.includes("Loaded module escaped owned source"),"required actual escaped loader rejection: "+error);',
      'assert.notEqual(Reflect.get(globalThis,"__orbit_escape_executed"),true,"rejected bytes executed");',
      'let snapshotError; try {await measurement.finish();} catch(held) {snapshotError=String(held);}',
      'assert(snapshotError?.includes("Dependency resolution escaped the owned dependency tree"),"required rejected snapshot: "+snapshotError);',
      'const rejectedSnapshot={status:"rejected",error:snapshotError,after:"not measured",stable:"not measured"};',
      'const info=await lstat(target),aliasTarget=await readlink(target),canonical=await realpath(target);',
      'assert(info.isSymbolicLink() && info.nlink===1);',
      'if(process.platform!=="win32" && typeof process.getuid==="function") assert.equal(info.uid,process.getuid());',
      'assert.equal(aliasTarget,outside);assert.equal(canonical,outside);',
      'const aliasCleanup={path:target,target:aliasTarget,canonical,uid:info.uid,ownership:process.platform!=="win32" && typeof process.getuid==="function"?"posix-uid":"Windows account ownership: not measured",nlink:info.nlink,mode:info.mode,dev:info.dev,ino:info.ino,status:"owned synthetic alias removed after retaining rejected snapshot"};',
      'const held=await lstat(target);for(const key of ["dev","ino","uid","mode","nlink"]) assert.equal(held[key],info[key]);assert.equal(await readlink(target),aliasTarget);',
      'await unlink(target);let aliasExistsAfterCleanup=true;',
      'try {await lstat(target);} catch(held) {assert.equal(held.code,"ENOENT");aliasExistsAfterCleanup=false;}',
      'assert.equal(aliasExistsAfterCleanup,false);',
      'const receipt=await measurement.finish();',
      'console.log(JSON.stringify({error,rejectedSnapshot,aliasCleanup,aliasExistsAfterCleanup,executed:Reflect.get(globalThis,"__orbit_escape_executed")===true,receipt}));',
    ].join("\n");
    const snapshotEscapeDriver = [
      'import {sharedRuntimeSnapshot} from "./browser-performance-identity";',
      'import {writeFile,symlink,unlink} from "node:fs/promises";',
      'import {strict as assert} from "node:assert";',
      `const target=${JSON.stringify(join(root, "src/pre-snapshot-escaped.js"))};`,
      `const outside=${JSON.stringify(outside)};`,
      'await writeFile(outside,"globalThis.__orbit_escape_executed=true; export const value=13;\\n");',
      'await symlink(outside,target);',
      'let error; try {await sharedRuntimeSnapshot(process.execPath);} catch(held) {error=String(held);}',
      'assert(error?.includes("Dependency resolution escaped the owned dependency tree"),"required pre-snapshot outside alias rejection: "+error);',
      'assert.notEqual(Reflect.get(globalThis,"__orbit_escape_executed"),true,"snapshot executed outside bytes");',
      'await unlink(target);',
      'console.log(JSON.stringify({error,executed:Reflect.get(globalThis,"__orbit_escape_executed")===true,snapshot:"rejected"}));',
    ].join("\n");
    await writeFile(join(root, "experiments/driver.ts"), kind === "escape" ? escapeDriver
      : kind === "snapshot-escape" ? snapshotEscapeDriver : regularDriver);
    // Each worker gets its own module cache and process-lifetime Bun plugin.
    const result = Bun.spawnSync([process.execPath, join(root, "experiments/driver.ts")],
      { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  } finally {
    await rm(rawRoot, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
}

test("actual CTS producer finishes with transformed bytes and original filename", async () => {
  const result = await executeFixture("cts");
  expect(result.actual).toBe(13);
  const receipt = result.receipt;
  expect(receipt.failures).toEqual([]);
  expect(receipt.stable).toBe(true);
  expect(receipt.loadedStable).toBe(true);
  expect(receipt.entryLoaded).toBe(true);
  const row = receipt.loaded.find((item: { path: string }) => item.path.endsWith("fixture.cts"));
  expect(row).toBeDefined();
  expect(row.delivery).toBe("commonjs-typescript-compile");
  expect(row.compilerFilename).toBe(row.path);
  expect(row.transform.input).toEqual({ path: row.path, sha256: row.sha256, bytes: row.bytes });
  expect(row.argumentSha256).not.toBe(row.sha256);
  expect(row.argumentSha256).toBe(hash(Buffer.from(row.transform.output.contents, "utf8")));
  expect(row.argumentBytes).toBe(Buffer.byteLength(row.transform.output.contents, "utf8"));
  expect(row.transform.options).toEqual({ loader: "ts", target: "bun" });
  expect(row.wrapperSha256).toBe(hash(wrapperBytes));
  expect(row.wrapperBytes).toBe(wrapperBytes.length);
}, 20_000);

test("actual JSON producer parses authenticated bytes and supplies object exports", async () => {
  const result = await executeFixture("json");
  expect(result.actual).toBe(41);
  const receipt = result.receipt;
  expect(receipt.failures).toEqual([]);
  expect(receipt.stable).toBe(true);
  expect(receipt.loadedStable).toBe(true);
  expect(receipt.entryLoaded).toBe(true);
  const row = receipt.loaded.find((item: { path: string }) => item.path.endsWith("data.json"));
  expect(row).toBeDefined();
  expect(row.loader).toBe("json");
  expect(row.delivery).toBe("commonjs-json-parse");
  expect(row.argumentSha256).toBe(row.sha256);
  expect(row.argumentBytes).toBe(row.bytes);
  expect(row.completed).toBe(true);
}, 20_000);


test("actual escaped alias is rejected before native Bun resolution and remains sticky", async () => {
  const result = await executeFixture("escape");
  expect(result.error).toContain("Loaded module escaped owned source");
  expect(result.executed).toBe(false);
  expect(result.rejectedSnapshot.status).toBe("rejected");
  expect(result.rejectedSnapshot.error).toContain("Dependency resolution escaped the owned dependency tree");
  expect(result.rejectedSnapshot.after).toBe("not measured");
  expect(result.rejectedSnapshot.stable).toBe("not measured");
  expect(result.aliasCleanup.target).toBe(result.aliasCleanup.canonical);
  expect(result.aliasCleanup.nlink).toBe(1);
  expect(result.aliasCleanup.ownership).toBe(process.platform !== "win32" && typeof process.getuid === "function"
    ? "posix-uid" : "Windows account ownership: not measured");
  expect(result.aliasCleanup.status).toBe("owned synthetic alias removed after retaining rejected snapshot");
  expect(result.aliasExistsAfterCleanup).toBe(false);
  expect(result.receipt.stable).toBe(false);
  expect(result.receipt.loadedStable).toBe(false);
  expect(result.receipt.failures.some((failure: string) => failure.includes("Loaded module escaped owned source"))).toBe(true);
}, 20_000);


test("pre-snapshot outside alias refuses dependency snapshot and executes nothing", async () => {
  const result = await executeFixture("snapshot-escape");
  expect(result.snapshot).toBe("rejected");
  expect(result.error).toContain("Dependency resolution escaped the owned dependency tree");
  expect(result.executed).toBe(false);
}, 20_000);
