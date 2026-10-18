import { dlopen, ptr, type Pointer } from "bun:ffi";
import { win32 } from "node:path";
import { debugDuplicateRights } from "./windows-debug-contract";

// Windows x64 only. No existing-process attach or PID-based acquisition API.
export function debugNative() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 debug feasibility is not measured");
  const library = dlopen("kernel32.dll", {
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "bool", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
    GetCurrentProcess: { args: [], returns: "ptr" }, GetCurrentThreadId: { args: [], returns: "u32" }, Sleep: { args: ["u32"], returns: "void" },
    DuplicateHandle: { args: ["ptr", "ptr", "ptr", "ptr", "u32", "bool", "u32"], returns: "bool" },
    InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "bool" },
    UpdateProcThreadAttribute: { args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"], returns: "bool" },
    DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "bool" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
    IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "bool" },
    QueryInformationJobObject: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "bool" },
    TerminateJobObject: { args: ["ptr", "u32"], returns: "bool" },
    DebugSetProcessKillOnExit: { args: ["bool"], returns: "bool" },
    WaitForDebugEvent: { args: ["ptr", "u32"], returns: "bool" },
    ContinueDebugEvent: { args: ["u32", "u32", "u32"], returns: "bool" },
    ResumeThread: { args: ["ptr"], returns: "u32" },
    TerminateProcess: { args: ["ptr", "u32"], returns: "bool" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
    QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "bool" },
    GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "bool" },
    GetProcessId: { args: ["ptr"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "bool" }, GetLastError: { args: [], returns: "u32" },
  });
  const api = library.symbols;
  const handle = (value: number) => value as Pointer;
  const fail = (name: string): never => { throw new Error(`${name}: Win32 error ${api.GetLastError()}`); };
  const number = (value: bigint | number | Pointer | null) => {
    const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Native handle is unknown"); return result;
  };
  const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le");
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  const close = (value: number) => { if (!api.CloseHandle(handle(value))) fail("CloseHandle explicit owned handle"); };
  const times = (value: number) => {
    const created = new Uint8Array(8), exited = new Uint8Array(8), kernel = new Uint8Array(8), user = new Uint8Array(8);
    if (!api.GetProcessTimes(handle(value), ptr(created), ptr(exited), ptr(kernel), ptr(user))) fail("GetProcessTimes exact handle");
    return { creationTicks: new DataView(created.buffer).getBigUint64(0, true).toString(), exitTicks: new DataView(exited.buffer).getBigUint64(0, true).toString() };
  };
  const identity = (value: number) => {
    const image = new Uint8Array(65536), size = new Uint32Array([32768]);
    if (!api.QueryFullProcessImageNameW(handle(value), 1, ptr(image), ptr(size))) fail("QueryFullProcessImageNameW exact handle");
    return { creationTicks: times(value).creationTicks, image: win32.basename(Buffer.from(image.subarray(0, (size[0] ?? 0) * 2)).toString("utf16le")) };
  };
  const state = (value: number) => {
    const wait = api.WaitForSingleObject(handle(value), 0); if (wait !== 0 && wait !== 258) fail("WaitForSingleObject exact handle");
    const code = new Uint32Array(1); if (!api.GetExitCodeProcess(handle(value), ptr(code))) fail("GetExitCodeProcess exact handle");
    const ticks = times(value); if (wait === 0 && ticks.exitTicks === "0") throw new Error("Exit ticks are not measured");
    return { state: wait === 0 ? "exited" : "alive", exitCode: code[0] ?? 0, ...ticks };
  };
  const duplicate = (value: number, target: number, purpose: "observation" | "creator-root") => {
    const out = new BigUint64Array(1);
    if (!api.DuplicateHandle(api.GetCurrentProcess(), handle(value), handle(target), ptr(out), debugDuplicateRights(purpose), false, 0)) fail(`DuplicateHandle ${purpose}`);
    return number(out[0] ?? 0n);
  };
  const create = (argv: string[], cwd: string, debug: boolean, inheritedController?: number) => {
    let attribute: Uint8Array | undefined;
    let attributeInitialized = false;
    let list: BigUint64Array | undefined;
    const startup = new Uint8Array(inheritedController === undefined ? 104 : 112), info = new Uint8Array(24);
    const start = new DataView(startup.buffer); start.setUint32(0, startup.length, true);
    try {
    if (inheritedController !== undefined) {
      const size = new BigUint64Array(1); api.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));
      const bytes = Number(size[0] ?? 0n); if (bytes <= 0 || bytes > 65536) throw new Error("Attribute size invalid");
      attribute = new Uint8Array(bytes);
      if (!api.InitializeProcThreadAttributeList(ptr(attribute), 1, 0, ptr(size))) fail("Initialize owned handle list");
      attributeInitialized = true;
      list = new BigUint64Array([BigInt(inheritedController)]);
      if (!api.UpdateProcThreadAttribute(ptr(attribute), 0, 0x00020002, ptr(list), 8, null, null)) fail("Explicit controller-only handle list");
      start.setBigUint64(104, BigInt(ptr(attribute)), true);
    }
    const executable = argv[0]; if (!executable) throw new Error("Missing executable");
    const env = wide(Object.entries({ PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: cwd, TMP: cwd })
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
      const flags = 0x08000404 | (debug ? 1 : 0) | (inheritedController === undefined ? 0 : 0x80000);
      if (!api.CreateProcessW(ptr(wide(executable)), ptr(wide(argv.map(quote).join(" "))), null, null, inheritedController !== undefined, flags,
        ptr(env), ptr(wide(cwd)), ptr(startup), ptr(info))) fail("Create private suspended process");
      const view = new DataView(info.buffer);
      return { process: number(view.getBigUint64(0, true)), thread: number(view.getBigUint64(8, true)), pid: view.getUint32(16, true) };
    } finally { if (attribute && attributeInitialized) api.DeleteProcThreadAttributeList(ptr(attribute)); }
  };
  return { api, ptr, number, handle, fail, close, times, identity, state, duplicate, create,
    controllerTransferHandle() {
      const out = new BigUint64Array(1);
      if (!api.DuplicateHandle(api.GetCurrentProcess(), api.GetCurrentProcess(), api.GetCurrentProcess(), ptr(out), 0x40, true, 0))
        fail("Create inheritable controller transfer handle");
      return number(out[0] ?? 0n);
    },
    dispose: () => library.close() };
}
