import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertSameIdentity } from "./windows-census-fixture";
import { captureProcessWitnesses, WitnessCaptureError, type WitnessApi } from "./windows-process-witness";

function fixture() {
  let live = true;
  const held = new Set<number>(), closed: number[] = [];
  const api: WitnessApi = {
    open(pid) { if (pid !== 42 || !live) throw new Error("OpenProcess owned PID 42 failed, error 87"); held.add(1042); return 1042; },
    identity(handle) { if (!held.has(handle)) throw new Error("Identity is unknown"); return { creationTicks: "104200", image: "bun.exe" }; },
    state(handle) { if (!held.has(handle)) throw new Error("State is unknown"); return { state: live ? "alive" : "exited", exitCode: live ? 259 : 0, exitTicks: live ? "0" : "104300" }; },
    close(handle) { closed.push(handle); held.delete(handle); },
  };
  return { api, closed, exit() { live = false; } };
}

test("portable deferred acquisition remains unknown after census child exit", () => {
  const box = fixture(); box.exit();
  expect(() => captureProcessWitnesses([42], box.api)).toThrow("error 87");
  expect(box.closed).toEqual([]);
});

test("portable retained capture preserves the same identity after census completion", () => {
  const box = fixture(), handle = box.api.open(42), before = box.api.identity(handle);
  box.exit();
  const witnesses = captureProcessWitnesses([42], { ...box.api, open(pid) { if (pid !== 42) throw new Error("Unowned process"); return handle; } });
  const [measured] = witnesses.observe();
  if (!measured) throw new Error("Owned identity is absent");
  assertSameIdentity(measured, before);
  expect(measured).toMatchObject({ pid: 42, state: "exited", exitTicks: "104300" });
  expect(() => assertSameIdentity({ ...measured, creationTicks: "other" }, before)).toThrow("changed");
  witnesses.close();
  expect(box.closed).toEqual([handle]);
});

test("portable partial capture preserves failed close ownership for retry", () => {
  const box = fixture();
  box.api.identity = () => { throw new Error("Identity unknown"); };
  box.api.close = () => { throw new Error("CloseHandle refused"); };
  let failure: unknown;
  try { captureProcessWitnesses([42], box.api); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WitnessCaptureError);
  if (!(failure instanceof WitnessCaptureError)) throw new Error("Retryable ownership is missing");
  box.api.close = handle => { box.closed.push(handle); };
  failure.close();
  expect(box.closed).toEqual([1042]);
});

// Execute the fixture's exact cleanup scope with native boundaries injected.
// This portable control does not measure Windows APIs or real process handles.
test("actual fixture cleanup closure retries a retained creator after job closure", async () => {
  const currentSource = fileURLToPath(new URL("./windows-census-fixture.ts", import.meta.url));
  const controlPath = fileURLToPath(import.meta.url);
  const sourcePath = process.env.ORBIT_WINDOWS_CENSUS_CONTROL_SOURCE ?? currentSource;
  const expectedSource = process.env.ORBIT_WINDOWS_CENSUS_CONTROL_SOURCE_SHA256;
  const expectedControl = process.env.ORBIT_WINDOWS_CENSUS_CONTROL_SHA256;
  if (!isAbsolute(sourcePath) || (sourcePath !== currentSource && !/^[a-f0-9]{64}$/.test(expectedSource ?? "")))
    throw new Error("Frozen alternate fixture requires its exact absolute path and SHA256");
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const sourceBytes = await readFile(sourcePath), controlBytes = await readFile(controlPath);
  const sourceHash = hash(sourceBytes), controlHash = hash(controlBytes);
  if ((expectedSource && sourceHash !== expectedSource) || (expectedControl && controlHash !== expectedControl))
    throw new Error("Cleanup control source identity mismatch");
  const source = sourceBytes.toString("utf8");
  const unique = (anchor: string) => {
    const at = source.indexOf(anchor);
    if (at < 0 || source.indexOf(anchor, at + anchor.length) >= 0) throw new Error("Cleanup scope anchor missing or ambiguous");
    return at;
  };
  const from = unique("  let processHandle:"), until = unique("\n  try {\n    await writeFile(script,");
  if (from >= until) throw new Error("Cleanup scope source order changed");
  const scope = source.slice(from, until);
  const creatorAt = unique("  const closeCreator = () => {"), closeAt = unique("  const close = async () => {");
  if (!(from < creatorAt && creatorAt < closeAt && closeAt < until))
    throw new Error("Actual cleanup closure scope order changed");
  const wrapper = `function makeCleanup(api: any, witnessApi: any, ptr: any, rm: any, root: string) {
${scope}
processHandle = 101; threadHandle = 102; job = 103 as Pointer; assigned = true;
return { close, snapshot: () => ({ processHandle, threadHandle, parentHandle, job, cleaned, cleanupReceipt: { ...cleanupReceipt } }) };
}`;
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(wrapper);
  type Snapshot = { processHandle?: number; threadHandle?: number; parentHandle?: number; job: number | null; cleaned: boolean; cleanupReceipt: Record<string, unknown> };
  type Cleanup = { close(): Promise<void>; snapshot(): Snapshot };
  const makeCleanup = new Function(compiled + "\nreturn makeCleanup;")() as
    (api: object, witnessApi: object, ptr: (value: Uint8Array) => Uint8Array, remove: typeof rm, root: string) => Cleanup;
  const evidence = await mkdtemp(join(tmpdir(), "orbit-census-cleanup-evidence-"));
  const root = await mkdtemp(join(tmpdir(), "orbit-census-cleanup-owned-"));
  let exited = false, lastError = 0, processCloses = 0, jobCloses = 0, terminations = 0, processTerminations = 0;
  const held = new Set([101, 102, 103]);
  const api = {
    TerminateJobObject(handle: number) { if (handle !== 103 || !held.has(handle)) throw new Error("Unowned job"); exited = true; terminations++; return true; },
    QueryInformationJobObject(handle: number, _kind: number, accounting: Uint8Array) {
      if (handle !== 103 || !held.has(handle)) throw new Error("Unowned accounting query");
      new DataView(accounting.buffer).setUint32(40, exited ? 0 : 1, true); return true;
    },
    TerminateProcess(handle: number) {
      if (handle !== 101 || !held.has(handle)) throw new Error("Unowned process termination");
      processTerminations++;
      if (exited) { lastError = 5; return false; }
      exited = true; return true;
    },
    WaitForSingleObject() { return exited ? 0 : 258; },
    CloseHandle(handle: number) {
      if (!held.has(handle)) throw new Error("Unowned or duplicate handle close");
      if (handle === 101 && ++processCloses === 1) { lastError = 6; return false; }
      if (handle === 103) jobCloses++;
      held.delete(handle); return true;
    },
    GetLastError() { return lastError; },
  };
  const cleanup = makeCleanup(api, { close() { throw new Error("Unexpected parent boundary"); } }, value => value,
    (async (path, options) => { if (path !== root) throw new Error("Unowned directory removal"); await rm(path, options); }) as typeof rm, root);
  let outcome = "not measured", phase = "initialization", errorText: string | undefined;
  let errorCauses: string[] = [];
  const snapshots: Snapshot[] = [];
  try {
    await writeFile(join(root, "owned.txt"), "owned cleanup control\n");
    phase = "first cleanup";
    await expect(cleanup.close()).rejects.toThrow("Owned fixture cleanup remains retryable");
    snapshots.push(cleanup.snapshot());
    expect(cleanup.snapshot()).toMatchObject({ processHandle: 101, threadHandle: undefined, job: null, cleaned: false });
    expect(exited).toBe(true);
    expect(jobCloses).toBe(1);
    expect(held).toEqual(new Set([101]));
    expect((await stat(root)).isDirectory()).toBe(true);
    phase = "retry creator close";
    await cleanup.close();
    snapshots.push(cleanup.snapshot());
    expect(processTerminations).toBe(0);
    expect(terminations).toBe(1);
    expect(processCloses).toBe(2);
    expect(jobCloses).toBe(1);
    expect(held.size).toBe(0);
    expect(cleanup.snapshot()).toMatchObject({ processHandle: undefined, job: null, cleaned: true });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    phase = "completed";
    outcome = "portable same-closure cleanup retry passed";
  } catch (error) {
    outcome = "portable same-closure cleanup retry failed";
    errorText = error instanceof Error ? error.message : String(error);
    errorCauses = error instanceof AggregateError ? error.errors.map(cause => cause instanceof Error ? cause.message : String(cause)) : [];
    throw error;
  } finally {
    try {
      const sourceAfter = hash(await readFile(sourcePath)), controlAfter = hash(await readFile(controlPath));
      const receipt = { state: outcome, phase, limit: "Actual fixture cleanup source and real owned directory; native API and handle boundaries mocked. Windows runtime not measured.",
        sourcePath, sourceSha256: sourceHash, sourceAfterSha256: sourceAfter,
        controlPath, controlSha256: controlHash, controlAfterSha256: controlAfter,
        scopeSha256: hash(Buffer.from(scope)), compiledSha256: hash(Buffer.from(compiled)), snapshots,
        boundaries: { exited, lastError, processCloses, jobCloses, terminations, processTerminations, retainedHandles: [...held] }, error: errorText, errorCauses };
      await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
      console.log(JSON.stringify({ cleanupControlReceipt: join(evidence, "receipt.json"), sourceSha256: sourceHash, controlSha256: controlHash }));
      if (sourceAfter !== sourceHash || controlAfter !== controlHash) throw new Error("Cleanup control source changed during execution");
    } finally {
      // Release only the control's mocked ownership and its real private directory.
      held.clear();
      await rm(root, { recursive: true, force: true });
    }
  }
});
