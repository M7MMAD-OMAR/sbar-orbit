import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { captureOwnedCensus, type CensusRow } from "./windows-owned-census";
import { captureProcessWitnesses, WitnessCaptureError, type WitnessApi } from "./windows-process-witness";

const child: CensusRow = { pid: 42, parentPid: 1, image: "bun.exe" };
function fixture() {
  const live = new Set([1, 42, 43]), held = new Set<number>(), opened: number[] = [], closed: number[] = [];
  const api: WitnessApi = {
    open(pid) {
      if (!live.has(pid)) throw new Error(`OpenProcess owned PID ${pid} failed, error 87`);
      opened.push(pid); held.add(pid + 1000); return pid + 1000;
    },
    identity(handle) {
      if (!held.has(handle)) throw new Error("Identity unknown");
      return { creationTicks: String((handle - 1000) * 100), image: "bun.exe" };
    },
    state(handle) {
      if (!held.has(handle)) throw new Error("State unknown");
      const alive = live.has(handle - 1000);
      return { state: alive ? "alive" : "exited", exitCode: alive ? 259 : 0, exitTicks: alive ? "0" : "9000" };
    },
    close(handle) {
      if (!held.delete(handle)) throw new Error("Duplicate or unowned close");
      closed.push(handle);
    },
  };
  return { api, live, held, opened, closed };
}

test("actual browser acquisition scope retains identity before enumeration completion", async () => {
  const alternate = process.env.ORBIT_WINDOWS_CENSUS_OLD_ROOT;
  const file = alternate ? join(alternate, "tests/browser-crash.test.ts") : new URL("./browser-crash.test.ts", import.meta.url);
  if (alternate && (!isAbsolute(alternate) || !/^[a-f0-9]{64}$/.test(process.env.ORBIT_WINDOWS_CENSUS_OLD_BROWSER_SHA256 ?? "")))
    throw new Error("Old source requires absolute root and immutable browser SHA256");
  const bytes = await readFile(file), source = bytes.toString("utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (alternate && digest !== process.env.ORBIT_WINDOWS_CENSUS_OLD_BROWSER_SHA256)
    throw new Error("Old browser source identity mismatch");
  const anchor = alternate ? "    const owned = await descendants(brokerProcess.pid);" : "    let owned: number[] = [];";
  const from = source.indexOf(anchor), until = source.indexOf('    brokerProcess.kill("SIGKILL");', from);
  if (from < 0 || until < from || source.indexOf(anchor, from + 1) !== -1)
    throw new Error("Actual browser acquisition scope missing or ambiguous");
  let capture = captureProcessWitnesses;
  if (alternate) {
    const oldFile = join(alternate, "tests/windows-process-witness.ts"), oldBytes = await readFile(oldFile);
    if (createHash("sha256").update(oldBytes).digest("hex") !== process.env.ORBIT_WINDOWS_CENSUS_OLD_WITNESS_SHA256)
      throw new Error("Old witness source identity mismatch");
    capture = (await import(oldFile)).captureProcessWitnesses;
  }
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function execute() {
let witnesses; let closeWitnesses;
${source.slice(from, until)}
return witnesses;
}`);
  const box = fixture();
  const scan = async (observe: (row: CensusRow) => void) => {
    observe(child);
    box.live.delete(42);
    await Promise.resolve();
  };
  const execute = new Function("captureOwnedCensus", "captureProcessWitnesses", "WitnessCaptureError", "windowsWitnessApi",
    "descendants", "brokerProcess", "process", "expect", "ownedParents", "console", "call", "socket", "session",
    compiled + "\nreturn execute;")(captureOwnedCensus, capture, WitnessCaptureError,
      async () => ({ ...box.api, scan }), async () => { await scan(() => {}); return [42, 43, 44, 45, 46]; },
      { pid: 1 }, { platform: "win32" }, () => ({ toBeGreaterThan() {} }), new Map([[42, 1]]), { error() {} },
      async () => {}, "owned", {}) as () => Promise<Awaited<ReturnType<typeof captureOwnedCensus>>>;
  try {
    const witness = await execute();
    expect(box.opened).toEqual([1, 42]);
    expect(witness.observe()[0]).toMatchObject({ pid: 42, creationTicks: "4200", state: "exited", exitTicks: "9000",
      parentPid: 1, parentIdentity: { creationTicks: "100", image: "bun.exe" } });
    witness.close();
    expect(box.held.size).toBe(0);
  } finally {
    console.log(JSON.stringify({ acquisitionScopeSource: String(file), sha256: digest,
      scopeSha256: createHash("sha256").update(source.slice(from, until)).digest("hex"), opened: box.opened, retained: [...box.held] }));
    // The failure control uses injected handles only.
    box.held.clear();
  }
});

test("out of order child is captured as soon as its owned parent is observed", async () => {
  const box = fixture();
  const census = await captureOwnedCensus(1, box.api, observe => {
    observe({ pid: 43, parentPid: 42, image: "bun.exe" });
    expect(box.opened).toEqual([1]);
    observe(child);
    expect(box.opened).toEqual([1, 42, 43]);
  });
  expect(census.observe()[1]).toMatchObject({ parentPid: 42, parentIdentity: { creationTicks: "4200" } });
  census.close(); expect(box.held.size).toBe(0);
});

test("unowned cycle acquires no handles and root cycle terminates", async () => {
  const box = fixture();
  const census = await captureOwnedCensus(1, box.api, observe => {
    observe({ pid: 98, parentPid: 99, image: "other.exe" });
    observe({ pid: 99, parentPid: 98, image: "other.exe" });
    observe({ pid: 1, parentPid: 42, image: "bun.exe" }); observe(child);
  });
  expect(box.opened).toEqual([1, 42]); census.close();
});

test("error 87 is unknown and releases retained root", async () => {
  const box = fixture(); box.live.delete(42);
  await expect(captureOwnedCensus(1, box.api, observe => observe(child))).rejects.toThrow("error 87");
  expect(box.held.size).toBe(0);
});

test("identity failure releases partial child and root", async () => {
  const box = fixture(), identity = box.api.identity;
  box.api.identity = handle => { if (handle === 1042) throw new Error("Identity unknown"); return identity(handle); };
  await expect(captureOwnedCensus(1, box.api, observe => observe(child))).rejects.toThrow("Identity unknown");
  expect(box.held.size).toBe(0);
});

test("scanner rejection releases observed children", async () => {
  const box = fixture();
  await expect(captureOwnedCensus(1, box.api, async observe => { observe(child); throw new Error("Enumeration unknown"); }))
    .rejects.toThrow("Enumeration unknown");
  expect(box.held.size).toBe(0);
});

test("creation older than retained parent fails closed", async () => {
  const box = fixture(), identity = box.api.identity;
  box.api.identity = handle => ({ ...identity(handle), creationTicks: handle === 1042 ? "50" : "100" });
  await expect(captureOwnedCensus(1, box.api, observe => observe(child))).rejects.toThrow("identity changed");
  expect(box.held.size).toBe(0);
});

test("snapshot image mismatch fails closed", async () => {
  const box = fixture();
  await expect(captureOwnedCensus(1, box.api, observe => observe({ ...child, image: "other.exe" }))).rejects.toThrow("identity changed");
  expect(box.held.size).toBe(0);
});

test("duplicate PID row is ambiguous and fails closed", async () => {
  const box = fixture();
  await expect(captureOwnedCensus(1, box.api, observe => { observe(child); observe(child); })).rejects.toThrow("ambiguous");
  expect(box.held.size).toBe(0);
});

test("failed cleanup preserves original ownership for retry without duplicate closes", async () => {
  const box = fixture(), close = box.api.close, identity = box.api.identity;
  let childCloseAttempts = 0, allowClose = false;
  box.api.identity = handle => { if (handle === 1042) throw new Error("Original child identity unknown"); return identity(handle); };
  box.api.close = handle => {
    if (handle === 1042) { childCloseAttempts++; if (!allowClose) throw new Error("CloseHandle refused"); }
    close(handle);
  };
  let error: unknown;
  try { await captureOwnedCensus(1, box.api, observe => observe(child)); }
  catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(WitnessCaptureError);
  if (!(error instanceof WitnessCaptureError)) throw new Error("Retryable cleanup ownership missing");
  const primary = error.errors[0];
  expect(primary).toBeInstanceOf(WitnessCaptureError);
  if (!(primary instanceof WitnessCaptureError)) throw new Error("Original partial capture failure missing");
  expect(String(primary.errors[0])).toContain("Original child identity unknown");
  // One capture rollback and one aggregate rollback, each with one owner.
  expect(childCloseAttempts).toBe(2);
  expect(box.held).toEqual(new Set([1042]));
  allowClose = true; error.close(); error.close();
  expect(childCloseAttempts).toBe(3);
  expect(box.closed).toEqual([1001, 1042]);
});

test("scanner snapshot cleanup ownership is retained alongside process cleanup", async () => {
  const box = fixture(); let snapshotHeld = true, allowClose = false;
  const snapshotClose = () => { if (!allowClose) throw new Error("Snapshot close failed"); snapshotHeld = false; };
  let error: unknown;
  try { await captureOwnedCensus(1, box.api, observe => {
    observe(child); throw new WitnessCaptureError(new Error("Scan failed"), new Error("Snapshot close failed"), snapshotClose);
  }); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(WitnessCaptureError); expect(snapshotHeld).toBe(true); expect(box.held.size).toBe(0);
  if (!(error instanceof WitnessCaptureError)) throw new Error("Snapshot cleanup ownership missing");
  allowClose = true; error.close(); expect(snapshotHeld).toBe(false);
});

async function nativeScanner(boundary: object) {
  const file = new URL("./windows-process-witness.ts", import.meta.url), bytes = await readFile(file);
  const source = bytes.toString("utf8"), anchor = "    scan(observe) {", from = source.indexOf(anchor), until = source.indexOf("    open(pid) {", from);
  if (from < 0 || until < from || source.indexOf(anchor, from + 1) !== -1) throw new Error("Native scanner source scope is ambiguous");
  const scope = source.slice(from, until);
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`const scanner = { ${scope} };`);
  console.log(JSON.stringify({ nativeScopeSource: String(file), sha256: createHash("sha256").update(bytes).digest("hex"),
    scopeSha256: createHash("sha256").update(scope).digest("hex") }));
  return new Function("api", "ptr", "process", "fail", "WitnessCaptureError", compiled + "\nreturn scanner.scan;")(
    boundary, (buffer: Uint8Array) => buffer, { arch: "x64" }, (operation: string) => { throw new Error(operation); }, WitnessCaptureError
  ) as (observe: (row: CensusRow) => void) => void;
}
function snapshotBoundary() {
  let error = 18, closed = false;
  return { api: {
    CreateToolhelp32Snapshot(flags: number, pid: number) { expect([flags, pid]).toEqual([2, 0]); return 501; },
    Process32FirstW(handle: number, entry: Uint8Array) {
      expect(handle).toBe(501); const view = new DataView(entry.buffer); expect(view.getUint32(0, true)).toBe(568);
      view.setUint32(8, 42, true); view.setUint32(32, 1, true); entry.set(Buffer.from("bun.exe\0", "utf16le"), 44); return true;
    },
    Process32NextW() { return false; },
    CloseHandle(handle: number) { expect(handle).toBe(501); expect(closed).toBe(false); closed = true; return true; },
    GetLastError() { return error; },
  }, setError(value: number) { error = value; }, closed: () => closed };
}

test("actual native scanner observes row before completion and closes snapshot", async () => {
  const box = snapshotBoundary(), scan = await nativeScanner(box.api); const rows: CensusRow[] = [];
  scan(row => { expect(box.closed()).toBe(false); rows.push(row); });
  expect(rows).toEqual([child]); expect(box.closed()).toBe(true);
});

test("actual native scanner rejects non terminal enumeration failure and closes snapshot", async () => {
  const box = snapshotBoundary(); box.setError(5); const scan = await nativeScanner(box.api);
  expect(() => scan(() => {})).toThrow("enumeration failed, error 5"); expect(box.closed()).toBe(true);
});

test("actual native scanner callback failure releases snapshot", async () => {
  const box = snapshotBoundary(), scan = await nativeScanner(box.api);
  expect(() => scan(() => { throw new Error("Acquisition unknown"); })).toThrow("Acquisition unknown"); expect(box.closed()).toBe(true);
});

test("actual native scanner failed snapshot close carries retryable ownership", async () => {
  const box = snapshotBoundary(), close = box.api.CloseHandle; let allow = false;
  box.api.CloseHandle = handle => allow ? close(handle) : false;
  const scan = await nativeScanner(box.api); let error: unknown;
  try { scan(() => {}); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(WitnessCaptureError); expect(box.closed()).toBe(false);
  if (!(error instanceof WitnessCaptureError)) throw new Error("Native snapshot retry ownership missing");
  allow = true; error.close(); error.close(); expect(box.closed()).toBe(true);
});

test("actual native scanner invalid snapshot is unknown and never closed as owned", async () => {
  const box = snapshotBoundary(); box.api.CreateToolhelp32Snapshot = () => Number(0xffffffffffffffffn);
  const scan = await nativeScanner(box.api);
  expect(() => scan(() => {})).toThrow("CreateToolhelp32Snapshot"); expect(box.closed()).toBe(false);
});
