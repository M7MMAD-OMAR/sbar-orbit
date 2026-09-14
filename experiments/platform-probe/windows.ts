import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { run } from "./run";
import { fixture } from "./fixture";

/**
 * Windows, the gates from docs/porting.md section 9 that need this host: G15, can Bun serve RPC
 * over a named pipe; G16, do Chrome's own processes stay inside an Orbit job object; G17, does a
 * 2 GiB commit ceiling and a hard CPU cap leave headless Chrome able to render a page. Plus the
 * w.* probes: browser resolution through App Paths, kernel32 through bun:ffi, and the native
 * messaging host registration state.
 */

async function reg(key: string) {
  const { out, code } = await run(["reg", "query", key, "/ve"], { allowFailure: true, timeoutMs: 10000 });
  const match = /REG_SZ\s+(.+)$/m.exec(out);
  return code === 0 && match ? match[1]!.trim() : null;
}

async function browserPath() {
  const found: Record<string, string | null> = {};
  for (const [name, exe] of [["chrome", "chrome.exe"], ["edge", "msedge.exe"]] as const) {
    for (const hive of ["HKLM", "HKCU"]) found[`${name}:${hive}`] = await reg(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`);
  }
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  for (const root of roots) {
    for (const candidate of [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")])
      if (existsSync(candidate)) found[candidate] = String(statSync(candidate).size);
  }
  const chrome = Object.entries(found).find(([k, v]) => k.startsWith("chrome") && v && existsSync(v))?.[1] ?? Object.keys(found).find(k => k.endsWith("chrome.exe") && existsSync(k)) ?? null;
  return { found, chrome };
}

const pipeName = () => `\\\\.\\pipe\\sbar-orbit-probe-${crypto.randomUUID()}`;

/** G15 half one: does Bun's own server take a pipe name. Half two: node:net with explicit framing. */
async function pipeServe() {
  const result: Record<string, unknown> = {};
  try {
    const server = Bun.serve({ unix: pipeName(), fetch: () => new Response("ok") });
    result.bunServeUnix = "listening";
    server.stop(true);
  } catch (error) { result.bunServeUnix = `refused: ${(error as Error).message.slice(0, 160)}`; }
  const name = pipeName();
  result.nodeNetPipe = await new Promise<string>(resolve => {
    const server = createServer(socket => socket.on("data", data => { socket.end(`echo:${data}`); }));
    server.on("error", error => resolve(`listen failed: ${error.message}`));
    server.listen(name, () => {
      const client = connect(name);
      client.on("error", error => { server.close(); resolve(`connect failed: ${error.message}`); });
      client.on("data", data => { client.end(); server.close(); resolve(String(data)); });
      client.write("ping");
    });
    setTimeout(() => { server.close(); resolve("timed out"); }, 10000);
  });
  // The DACL a pipe gets by default, read back while listening, which is what w.pipe.dacl compares against.
  const held = pipeName();
  result.defaultDacl = await new Promise<string>(resolve => {
    const server = createServer(() => {});
    server.listen(held, async () => {
      // pwsh rather than Windows PowerShell: on the runner the latter could not load its Security module.
      // Get-Acl cannot open a pipe (error 87); a client stream can, and reads the ACL off its handle.
      const { out, err } = await run(["pwsh", "-NoProfile", "-Command", `$c = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${held.replace("\\\\.\\pipe\\", "")}', 'InOut'); $c.Connect(3000); [System.IO.Pipes.PipesAclExtensions]::GetAccessControl($c).GetSecurityDescriptorSddlForm('All'); $c.Dispose()`], { allowFailure: true, timeoutMs: 30000 });
      server.close(); resolve(out || `unreadable: ${err.slice(0, 160)}`);
    });
    server.on("error", error => resolve(`listen failed: ${error.message}`));
  });
  // AF_UNIX exists on Windows 10 1803 and later; whether Bun binds one on a filesystem path is its own answer.
  try {
    const path = join(mkdtempSync(join(tmpdir(), "orbit-unix-")), "s.sock");
    const listener = Bun.listen({ unix: path, socket: { data() {} } });
    result.bunAfUnix = "bound"; listener.stop(true);
  } catch (error) { result.bunAfUnix = `refused: ${(error as Error).message.slice(0, 160)}`; }
  return result;
}

/** kernel32 through bun:ffi, and the job object primitives G16 and G17 rest on. */
function kernel32() {
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
}
const PROCESS_SET_QUOTA = 0x0100, PROCESS_TERMINATE = 0x0001, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const JobObjectBasicProcessIdList = 3, JobObjectExtendedLimitInformation = 9, JobObjectCpuRateControlInformation = 15;
const LIMIT_JOB_MEMORY = 0x200, LIMIT_KILL_ON_JOB_CLOSE = 0x2000, CPU_RATE_ENABLE = 1, CPU_RATE_HARD_CAP = 4;

async function chromeProcesses() {
  const { out } = await run(["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { allowFailure: true, timeoutMs: 30000 });
  if (!out) return [] as { ProcessId: number; ParentProcessId: number }[];
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; ParentProcessId: number }[];
}
function descendants(all: { ProcessId: number; ParentProcessId: number }[], root: number) {
  const set = new Set<number>([root]);
  let grew = true;
  while (grew) { grew = false; for (const p of all) if (set.has(p.ParentProcessId) && !set.has(p.ProcessId)) { set.add(p.ProcessId); grew = true; } }
  return [...set];
}

/** A job with the given limits, a Chrome inside it, and what happened to Chrome's own children. */
async function chromeInJob(options: { commitCeiling?: number; cpuRatePercent?: number; screenshot?: boolean }) {
  const { chrome } = await browserPath();
  if (!chrome) throw new Error("no chrome.exe on this machine");
  const { dlopen, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  void dlopen;
  const k = kernel32().symbols;
  const job = k.CreateJobObjectW(null, null);
  if (!job) throw new Error(`CreateJobObjectW failed: ${k.GetLastError()}`);
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64 layout: BasicLimitInformation (64 bytes, LimitFlags at 16),
  // IoInfo (48), ProcessMemoryLimit at 112, JobMemoryLimit at 120, two peak fields, 144 in all.
  const extended = new Uint8Array(144); const view = new DataView(extended.buffer);
  let flags = LIMIT_KILL_ON_JOB_CLOSE;
  if (options.commitCeiling) { flags |= LIMIT_JOB_MEMORY; view.setBigUint64(120, BigInt(options.commitCeiling), true); }
  view.setUint32(16, flags, true);
  if (!k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(extended), 144)) throw new Error(`SetInformationJobObject(extended) failed: ${k.GetLastError()}`);
  if (options.cpuRatePercent) {
    const rate = new Uint8Array(8); const rv = new DataView(rate.buffer);
    rv.setUint32(0, CPU_RATE_ENABLE | CPU_RATE_HARD_CAP, true); rv.setUint32(4, options.cpuRatePercent * 100, true);
    if (!k.SetInformationJobObject(job, JobObjectCpuRateControlInformation, ptr(rate), 8)) throw new Error(`SetInformationJobObject(cpu rate) failed: ${k.GetLastError()}`);
  }
  const page = fixture();
  const profile = mkdtempSync(join(tmpdir(), "orbit-chrome-"));
  const shot = join(profile, "shot.png");
  const argv = [chrome, "--headless=new", "--no-first-run", "--disable-gpu", `--user-data-dir=${profile}`, "--window-size=1280,800", ...(options.screenshot ? [`--screenshot=${shot}`] : ["--remote-debugging-port=0"]), page.url];
  const started = performance.now();
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const handle = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, child.pid);
  const assigned = handle ? k.AssignProcessToJobObject(job, handle) : 0;
  const assignError = assigned ? 0 : k.GetLastError();
  await Bun.sleep(options.screenshot ? 8000 : 4000);
  const all = await chromeProcesses();
  const tree = descendants(all, child.pid);
  const membership: Record<number, boolean | string> = {};
  for (const pid of tree) {
    const h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!h) { membership[pid] = `open failed ${k.GetLastError()}`; continue; }
    const flag = new Uint8Array(4);
    membership[pid] = k.IsProcessInJob(h, job, ptr(flag)) ? new DataView(flag.buffer).getInt32(0, true) !== 0 : `query failed ${k.GetLastError()}`;
    k.CloseHandle(h);
  }
  const list = new Uint8Array(8 + 8 * 512);
  const listed = k.QueryInformationJobObject(job, JobObjectBasicProcessIdList, ptr(list), list.length, null) ? new DataView(list.buffer).getUint32(4, true) : -1;
  let screenshot: unknown = null;
  if (options.screenshot) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && child.exitCode === null) await Bun.sleep(250);
    screenshot = { exited: child.exitCode, bytes: existsSync(shot) ? statSync(shot).size : 0, ms: Math.round(performance.now() - started), stderrTail: (await new Response(child.stderr).text()).trim().slice(-300) };
  }
  // Closing the last handle to a KILL_ON_JOB_CLOSE job is the cleanup the design relies on.
  k.CloseHandle(job);
  if (handle) k.CloseHandle(handle);
  await Bun.sleep(1500);
  const after = await chromeProcesses();
  const survivors = tree.filter(pid => after.some(p => p.ProcessId === pid));
  for (const pid of survivors) await run(["taskkill", "/F", "/PID", String(pid)], { allowFailure: true, timeoutMs: 10000 });
  page.stop();
  return { assigned: !!assigned, assignError, chromeProcessesSeen: tree.length, inJob: Object.values(membership).filter(v => v === true).length, membership, jobListCount: listed, survivorsAfterClose: survivors.length, screenshot };
}

export const probes = {
  "w.browser.path": browserPath,
  "w.session": async () => ({ user: (await run(["whoami"])).out, session: (await run(["powershell", "-NoProfile", "-Command", "(Get-Process -Id $PID).SessionId"], { allowFailure: true })).out, interactive: (await run(["powershell", "-NoProfile", "-Command", "[Environment]::UserInteractive"], { allowFailure: true })).out }),
  "w.pipe.serve": pipeServe,
  "w.ffi": async () => { const k = kernel32(); return Object.keys(k.symbols); },
  "w.job.assign": async () => {
    const { ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const k = kernel32().symbols;
    const job = k.CreateJobObjectW(null, null);
    const extended = new Uint8Array(144); new DataView(extended.buffer).setUint32(16, LIMIT_KILL_ON_JOB_CLOSE, true);
    if (!k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(extended), 144)) throw new Error(`SetInformationJobObject failed: ${k.GetLastError()}`);
    const child = Bun.spawn(["powershell", "-NoProfile", "-Command", "Start-Sleep 60"], { stdout: "ignore", stderr: "ignore" });
    const handle = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, child.pid);
    const assigned = k.AssignProcessToJobObject(job, handle);
    const flag = new Uint8Array(4); k.IsProcessInJob(handle, job, ptr(flag));
    const inJob = new DataView(flag.buffer).getInt32(0, true) !== 0;
    k.CloseHandle(job);
    await Bun.sleep(1000);
    const died = child.exitCode !== null || child.signalCode !== null;
    if (!died) child.kill();
    k.CloseHandle(handle);
    return { assigned: !!assigned, inJob, diedOnJobClose: died };
  },
  "G16.chrome.in.job": () => chromeInJob({}),
  "G17.chrome.under.limits": () => chromeInJob({ commitCeiling: 2 * 1024 ** 3, cpuRatePercent: 25, screenshot: true }),
  "G17.chrome.unlimited.reference": () => chromeInJob({ screenshot: true }),
  // G28: the driverless half of the Windows egress question. A Windows Filtering Platform rule scoped
  // to a program path, made through the firewall, needs no driver; whether it holds a headless Chrome
  // is measured by fetching loopback and the internet from inside with the rule on, then off.
  "G28.wfp.program.rule": async () => {
    const { chrome } = await browserPath();
    if (!chrome) throw new Error("no chrome.exe on this machine");
    const page = fixture();
    const name = `orbit-probe-${crypto.randomUUID().slice(0, 8)}`;
    const attempt = async (label: string) => {
      const profile = mkdtempSync(join(tmpdir(), "orbit-wfp-"));
      const results: Record<string, unknown> = {};
      for (const [what, url] of [["loopback", page.url], ["internet", "https://example.com/"]] as const) {
        // The DOM rather than a screenshot: an error page and the real page are both a PNG, and only
        // the text says which one Chrome got.
        const child = Bun.spawn([chrome, "--headless=new", "--no-first-run", "--disable-gpu", `--user-data-dir=${profile}-${what}`, "--dump-dom", "--timeout=15000", url], { stdout: "pipe", stderr: "pipe" });
        const started = performance.now();
        await Promise.race([child.exited, Bun.sleep(40000)]);
        if (child.exitCode === null) child.kill();
        const [dom, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
        const expected = what === "loopback" ? "Orbit probe" : "Example Domain";
        results[what] = { exit: child.exitCode, ms: Math.round(performance.now() - started), reached: dom.includes(expected), domBytes: dom.length, title: /<title>([^<]*)<\/title>/.exec(dom)?.[1] ?? null, stderrTail: err.trim().slice(-120) };
      }
      return { label, ...results };
    };
    const before = await attempt("no rule");
    const made = await run(["pwsh", "-NoProfile", "-Command", `New-NetFirewallRule -DisplayName '${name}' -Direction Outbound -Program '${chrome}' -Action Block -Profile Any | Out-Null; (Get-NetFirewallRule -DisplayName '${name}').Enabled`], { allowFailure: true, timeoutMs: 60000 });
    const during = made.code === 0 ? await attempt("program rule blocking outbound") : { label: "rule not created", error: made.err.slice(-200) };
    await run(["pwsh", "-NoProfile", "-Command", `Remove-NetFirewallRule -DisplayName '${name}'`], { allowFailure: true, timeoutMs: 60000 });
    const after = await attempt("rule removed");
    page.stop();
    return { ruleCreated: made.code === 0 ? made.out : `refused: ${made.err.slice(-160)}`, before, during, after,
      note: "A firewall rule keyed to a program path is not keyed to a job: every chrome.exe on the machine is inside it, which is the design gap the gate names" };
  },
  "w.mint.registered": async () => {
    const found: Record<string, string> = {};
    for (const hive of ["HKLM", "HKCU"]) for (const browser of ["Google\\Chrome", "Microsoft\\Edge"]) {
      const { out, code } = await run(["reg", "query", `${hive}\\SOFTWARE\\${browser}\\NativeMessagingHosts`], { allowFailure: true, timeoutMs: 10000 });
      found[`${hive}\\${browser}`] = code === 0 ? out.split(/\r?\n/).filter(l => l.includes("NativeMessagingHosts\\")).map(l => l.trim().split("\\").at(-1)!).join(", ") || "empty" : "absent";
    }
    return found;
  },
};
