import { win32 } from "node:path";
import type { Pointer } from "bun:ffi";

export class WitnessCaptureError extends AggregateError {
  constructor(primary: unknown, cleanup: unknown, readonly close: () => void) {
    super([primary, cleanup], "Owned process witness capture and cleanup failed");
  }
}

export type WitnessIdentity = { creationTicks: string; image: string };
export type WitnessState = { state: "alive" | "exited"; exitCode: number; exitTicks: string };
export type WitnessApi = {
  open(pid: number): number;
  identity(handle: number): WitnessIdentity;
  state(handle: number): WitnessState;
  close(handle: number): void;
};

export function captureProcessWitnesses(pids: number[], api: WitnessApi) {
  if (pids.length > 512 || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0))
    throw new Error("Owned process witness PID set is invalid or exceeds its evidence bound");
  const held: { pid: number; handle: number; identity: WitnessIdentity; closed: boolean }[] = [];
  const close = () => {
    const failures: unknown[] = [];
    for (const item of held) {
      if (item.closed) continue;
      try { api.close(item.handle); item.closed = true; } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Owned process witness handle cleanup failed");
  };
  try {
    for (const pid of pids) {
      const handle = api.open(pid);
      const item = { pid, handle, identity: { creationTicks: "", image: "" }, closed: false };
      held.push(item);
      item.identity = api.identity(handle);
    }
  } catch (error) {
    try { close(); } catch (cleanup) { throw new WitnessCaptureError(error, cleanup, close); }
    throw error;
  }
  return { close, observe: () => held.map(item => {
    if (item.closed) throw new Error("Owned process witness is closed");
    return { pid: item.pid, ...item.identity, ...api.state(item.handle) };
  }) };
}

export async function windowsWitnessApi(): Promise<WitnessApi> {
  const { dlopen, ptr } = await import("bun:ffi");
  const api = dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
    GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
    QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "bool" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "bool" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;
  const fail = (operation: string): never => { throw new Error(`${operation} failed, error ${api.GetLastError()}`); };
  return {
    open(pid) {
      const handle = api.OpenProcess(0x00101000, false, pid);
      const value = Number(handle);
      if (!handle) fail(`OpenProcess owned PID ${pid}`);
      if (!Number.isSafeInteger(value)) {
        if (!api.CloseHandle(handle)) fail("CloseHandle unrepresentable process witness");
        throw new Error("Owned process handle cannot be represented safely");
      }
      return value;
    },
    identity(handle) {
      const times = Array.from({ length: 4 }, () => new Uint8Array(8));
      const [created, exited, kernel, user] = times;
      if (!created || !exited || !kernel || !user) throw new Error("Process time buffers missing");
      if (!api.GetProcessTimes(handle as Pointer, ptr(created), ptr(exited), ptr(kernel), ptr(user))) fail("GetProcessTimes");
      const image = new Uint8Array(32768 * 2), length = new Uint32Array([32768]);
      // Native paths remain queryable on retained handles after confirmed exit.
      // Win32 path conversion can fail with ERROR_GEN_FAILURE at that point.
      if (!api.QueryFullProcessImageNameW(handle as Pointer, 1, ptr(image), ptr(length))) fail("QueryFullProcessImageNameW");
      return { creationTicks: new DataView(created.buffer).getBigUint64(0, true).toString(),
        image: win32.basename(Buffer.from(image.subarray(0, (length[0] ?? 0) * 2)).toString("utf16le")) };
    },
    state(handle) {
      const wait = api.WaitForSingleObject(handle as Pointer, 0);
      if (wait !== 0 && wait !== 258) fail("WaitForSingleObject");
      const code = new Uint32Array(1);
      if (!api.GetExitCodeProcess(handle as Pointer, ptr(code))) fail("GetExitCodeProcess");
      let exitTicks = "0";
      if (wait === 0) {
        const created = new Uint8Array(8), exited = new Uint8Array(8), kernel = new Uint8Array(8), user = new Uint8Array(8);
        if (!api.GetProcessTimes(handle as Pointer, ptr(created), ptr(exited), ptr(kernel), ptr(user))) fail("GetProcessTimes exited witness");
        exitTicks = new DataView(exited.buffer).getBigUint64(0, true).toString();
        if (exitTicks === "0") throw new Error("Owned process exit time is unmeasured");
      }
      return { state: wait === 0 ? "exited" : "alive", exitCode: code[0] ?? 0, exitTicks };
    },
    close(handle) { if (!api.CloseHandle(handle as Pointer)) fail("CloseHandle owned process witness"); },
  };
}
