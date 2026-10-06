import { dlopen, ptr, type Pointer } from "bun:ffi";
import { win32 } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { requireResourceBudget } from "../src/resource-budget";
import { windowsWitnessApi } from "../tests/windows-process-witness";

// Only a disposable child started here is inspected. The same retained handle
// is queried alive and after that child exits. No other process is enumerated.
await requireResourceBudget();
if (process.platform !== "win32") throw new Error("Windows witness probe requires Windows");
const native = dlopen("kernel32.dll", {
  QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "bool" },
  GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
  WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
  GetLastError: { args: [], returns: "u32" },
});
const api = await windowsWitnessApi();
const child = Bun.spawn([process.execPath, "-e",
  'console.log("ready");await new Response(Bun.stdin.stream()).text();process.exit(0);'],
{ stdin: "pipe", stdout: "pipe", stderr: "pipe" });
let handle: number | undefined;
const output = "output/windows-witness-query";
const records: Record<string, unknown>[] = [];
const attempt = <T>(read: () => T): { ok: true; value: T } | { ok: false; error: string } => {
  try { return { ok: true, value: read() }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
};
const times = (retained: number) => {
  const created = new Uint8Array(8), exited = new Uint8Array(8), kernel = new Uint8Array(8), user = new Uint8Array(8);
  if (!native.symbols.GetProcessTimes(retained as Pointer, ptr(created), ptr(exited), ptr(kernel), ptr(user)))
    throw new Error(`Probe GetProcessTimes failed, error ${native.symbols.GetLastError()}`);
  return { creationTicks: new DataView(created.buffer).getBigUint64(0, true).toString(),
    exitTicks: new DataView(exited.buffer).getBigUint64(0, true).toString() };
};
const query = (retained: number, flags: number) => {
  const image = new Uint8Array(32768 * 2), length = new Uint32Array([32768]);
  const ok = native.symbols.QueryFullProcessImageNameW(retained as Pointer, flags, ptr(image), ptr(length));
  const error = ok ? null : native.symbols.GetLastError();
  return { flags, ok, error, image: ok
    ? win32.basename(Buffer.from(image.subarray(0, (length[0] ?? 0) * 2)).toString("utf16le")) : null };
};
const sample = (retained: number, phase: string) => {
  const record = { phase, pid: child.pid, win32: attempt(() => query(retained, 0)), native: attempt(() => query(retained, 1)),
    identity: attempt(() => api.identity(retained)), state: attempt(() => api.state(retained)),
    times: attempt(() => times(retained)), wait: attempt(() => {
      const result = native.symbols.WaitForSingleObject(retained as Pointer, 0);
      return { result, error: result === 0 || result === 258 ? null : native.symbols.GetLastError() };
    }) };
  records.push(record);
  return record;
};
try {
  await mkdir(output, { recursive: true });
  const reader = child.stdout.getReader();
  try {
    let ready = "";
    while (!ready.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("Disposable child exited before its ready signal");
      ready += new TextDecoder().decode(next.value);
    }
    if (ready.trim() !== "ready") throw new Error("Unexpected disposable child output");
  } finally { reader.releaseLock(); }
  handle = api.open(child.pid);
  const before = sample(handle, "before child exit");
  child.stdin.end();
  await child.exited;
  const after = sample(handle, "after child exit");
  if (!before.identity.ok || !before.times.ok || !before.wait.ok || before.wait.value.result !== 258
    || before.identity.value.image !== win32.basename(process.execPath)
    || before.identity.value.creationTicks !== before.times.value.creationTicks)
    throw new Error("Disposable live child identity is unconfirmed");
  if (!after.state.ok || !after.times.ok || !after.wait.ok || after.wait.value.result !== 0 || after.state.value.state !== "exited"
    || after.state.value.exitTicks === "0" || before.identity.value.creationTicks !== after.times.value.creationTicks
    || after.times.value.exitTicks !== after.state.value.exitTicks)
    throw new Error("Disposable child ownership or exit measurement is unconfirmed");
  for (const record of records) console.log(JSON.stringify(record));
} catch (error) {
  records.push({ phase: "probe failure", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  const cleanupFailures: unknown[] = [];
  if (child.exitCode === null) {
    const killed = attempt(() => child.kill());
    if (!killed.ok) { records.push({ phase: "child cleanup failure", ...killed }); cleanupFailures.push(killed.error); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Disposable child cleanup is unconfirmed")), 5000);
    })]);
  } catch (error) {
    records.push({ phase: "child exit cleanup failure", error: error instanceof Error ? error.message : String(error) });
    cleanupFailures.push(error);
  } finally { if (timer !== undefined) clearTimeout(timer); }
  if (handle !== undefined) {
    const retained = handle;
    const closed = attempt(() => api.close(retained));
    if (!closed.ok) { records.push({ phase: "handle cleanup failure", ...closed }); cleanupFailures.push(closed.error); }
  }
  const released = attempt(() => native.close());
  if (!released.ok) { records.push({ phase: "library cleanup failure", ...released }); cleanupFailures.push(released.error); }
  await writeFile(`${output}/query-results.json`, `${JSON.stringify(records, null, 2)}\n`);
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Windows witness probe cleanup failed");
}
