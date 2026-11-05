import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { open, mkdir, realpath, type FileHandle } from "node:fs/promises";
import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { OrbitError, normalizeDisposition, record } from "./errors";
import { requireResourceBudget } from "./resource-budget";
import { platformNativeEntry } from "./platform-native";

export type NativeOptions = { controlDirectory: string; appearanceDirectory?: string } &
  ({ adapter?: "hyprland"; planPath: string } | { adapter: "platform"; planPath?: never });

/**
 * What a native worker said as it died, from the last bytes of its private journal.
 *
 * A worker that cannot start used to leave only a Python traceback in a directory the broker then
 * deleted, so the person saw "Request failed" and the cause was visible to ABRT alone. Two things are
 * read back: the one bounded line the worker prints for a startup failure it classified, and, for a
 * death before that code ran (an import error), the final exception line of the traceback. Nothing
 * else of the journal leaves this function, and control characters never do.
 */
export function workerFailureDetail(logPath: string, bytes = 8192): string | undefined {
  let tail: string;
  try {
    const fd = openSync(logPath, "r");
    try {
      const size = fstatSync(fd).size, length = Math.min(size, bytes), buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      tail = buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return undefined; }
  const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  const lines = tail.split("\n");
  const fatal = lines.findLast(line => line.startsWith("ORBIT-WORKER-FATAL "));
  if (fatal) {
    try {
      const value = JSON.parse(fatal.slice("ORBIT-WORKER-FATAL ".length)) as { type?: unknown; message?: unknown };
      if (typeof value.type === "string" && typeof value.message === "string") return clean(`${value.type}: ${value.message}`);
    } catch { /* fall through to the traceback line */ }
  }
  const last = lines.findLast(line => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b.*$/.test(line));
  return last ? clean(last) : undefined;
}

export function nativeOptionsFromEnv(): NativeOptions | undefined {
  const planPath = process.env.ORBIT_NATIVE_PLAN, controlDirectory = process.env.ORBIT_NATIVE_CONTROL;
  const appearanceDirectory = process.env.ORBIT_NATIVE_APPEARANCE;
  const adapter = process.env.ORBIT_NATIVE_ADAPTER;
  if (planPath === undefined && controlDirectory === undefined && appearanceDirectory === undefined && adapter === undefined) return undefined;
  if (adapter !== undefined && adapter !== "hyprland" && adapter !== "platform")
    throw new OrbitError("INVALID_REQUEST", "Unknown native adapter configuration");
  if (process.platform === "win32" || process.platform === "darwin") {
    if (adapter === "hyprland" || planPath !== undefined || appearanceDirectory !== undefined)
      throw new OrbitError("INVALID_REQUEST", "Platform-native configuration uses an absolute control directory and no Hyprland plan or appearance snapshot");
    if (!controlDirectory || !isAbsolute(controlDirectory))
      throw new OrbitError("INVALID_REQUEST", "Platform-native configuration requires an absolute owner control directory");
    return { adapter: "platform", controlDirectory };
  }
  if (adapter === "platform") throw new OrbitError("UNSUPPORTED", "Platform-native configuration requires Windows or macOS");
  if (!planPath || !controlDirectory || !isAbsolute(planPath) || !isAbsolute(controlDirectory))
    throw new OrbitError("INVALID_REQUEST", "Native broker configuration requires absolute plan and control paths");
  if (appearanceDirectory !== undefined && (!appearanceDirectory || !isAbsolute(appearanceDirectory)))
    throw new OrbitError("INVALID_REQUEST", "Native appearance requires an absolute owner snapshot path");
  return { planPath, controlDirectory, ...(appearanceDirectory === undefined ? {} : { appearanceDirectory }) };
}

/** One bounded exchange at a time. Closing stdin is the worker's ownership cleanup signal. */
export class NativeWorker {
  private closing?: Promise<void>;
  private ended = false;
  private failure?: Error;
  private logClosing?: Promise<void>;
  private logWrites: Promise<unknown> = Promise.resolve();
  recoveryFailure?: unknown;
  private fragments: Buffer[] = [];
  private bytes = 0;
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private pending?: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private listeners: (() => void)[] = [];
  private exit: Promise<number | null>;

  /** Why the worker ended, read once from its journal after it closed. */
  exitDetail?: string;

  private constructor(readonly child: ChildProcess, private stdin: Writable, stdout: Readable, private log: FileHandle, private logPath: string,
    private readonly workerPlatform: NodeJS.Platform = process.platform, private readonly ownsProcessGroup = false) {
    this.exit = new Promise(resolve => child.once("close", async code => {
      this.ended = true;
      if (code !== 0) {
        this.exitDetail = workerFailureDetail(this.logPath);
        // The broker's own journal, beside the trace IDs, is where the operator looks. Not an RPC reply.
        console.error(JSON.stringify({ nativeWorkerExit: code, detail: this.exitDetail ?? "no exception line in the worker journal" }));
      }
      this.reject(this.failure ?? new OrbitError("BACKEND_ERROR", this.exitDetail ? "Native worker closed: " + this.exitDetail : "Native worker closed"));
      try { await this.releaseLog(); } catch (error) {
        this.failure ??= error instanceof Error ? error : new Error("Native log release failed");
      }
      resolve(code);
      for (const listener of this.listeners.splice(0)) listener();
    }));
    stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.on("error", error => this.abort(error));
    stdin.on("error", error => this.abort(error));
    stdout.on("error", error => this.abort(error));
    // The descriptor is retained by the parent until child close. Stderr never enters RPC replies.
  }

  static async create(directory: string, options: NativeOptions, entry?: string[]) {
    await requireResourceBudget();
    const platform = process.platform, platformNative = options.adapter === "platform";
    if (platformNative ? platform !== "win32" && platform !== "darwin" : platform !== "linux")
      throw new OrbitError("UNSUPPORTED", "Native configuration does not match this operating system");
    const fixedEntry = platformNative ? platformNativeEntry(platform) : ["/usr/bin/python3", join(import.meta.dir, "native/existing_worker.py")];
    if (platformNative && entry !== undefined && JSON.stringify(entry) !== JSON.stringify(fixedEntry))
      throw new OrbitError("INVALID_REQUEST", "Platform-native helpers require their fixed system entry");
    const command = entry ?? fixedEntry;
    if ((!platformNative && (!options.planPath || !isAbsolute(options.planPath))) || !isAbsolute(options.controlDirectory))
      throw new OrbitError("INVALID_REQUEST", "Native configuration paths must be absolute");
    if (platformNative && options.appearanceDirectory !== undefined)
      throw new OrbitError("UNSUPPORTED", "Platform-native appearance is not qualified");
    await mkdir(directory, { mode: 0o700 });
    const log = await open(join(directory, "worker.log"), "wx", 0o600);
    try {
      const env: NodeJS.ProcessEnv = { PATH: platform === "win32" ? process.env.PATH ?? "" : platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin", LANG: "C.UTF-8" };
      // Read the same owner preferences as the panel without inheriting credentials.
      for (const key of ["HOME", "XDG_CONFIG_HOME"] as const) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      if (platform === "win32") for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "COMSPEC", "USERNAME", "USERDOMAIN", "SESSIONNAME"])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      if (platform === "darwin") for (const key of ["TMPDIR", "SHELL", "USER", "LOGNAME", "LC_CTYPE"])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      // Experimental read-only helper is opt-in, never inferred from unrelated environment.
      if (!platformNative && process.env.ORBIT_A11Y_WARM_HOST === "1") env.ORBIT_A11Y_WARM_HOST = "1";
      // The plan path may be a stable name whose target a native refresh replaces; each worker binds the current one.
      const planPath = options.adapter === "platform" ? "" : await realpath(options.planPath).catch(() => options.planPath);
      const ownGroup = platformNative && platform === "darwin";
      const child = spawn(command[0] ?? "/usr/bin/python3", [...command.slice(1), directory, options.controlDirectory, planPath],
        { env, detached: ownGroup, windowsHide: true, stdio: ["pipe", "pipe", log.fd] });
      if (!child.stdin || !child.stdout) {
        child.kill("SIGTERM");
        throw new OrbitError("BACKEND_ERROR", "Native worker did not expose its framed streams");
      }
      return new NativeWorker(child, child.stdin, child.stdout, log, join(directory, "worker.log"), platform, ownGroup);
    } catch (error) {
      await log.close();
      throw error;
    }
  }

  onClose(listener: () => void) {
    if (this.ended) listener(); else this.listeners.push(listener);
  }

  private reject(error: Error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
  }

  private abort(error: Error) {
    if (this.failure) return;
    this.failure ??= error;
    this.logWrites = this.logWrites.then(() => this.log.write("Native channel failure: "
      + (error instanceof OrbitError ? error.code : "BACKEND_ERROR") + "\n"));
    this.reject(error);
    this.stdin.end();
    // Fatal framing and deadline errors must reap the worker even without a later stop RPC.
    void this.close().catch(error => { this.recoveryFailure = error; });
  }

  private releaseLog() {
    return this.logClosing ??= (async () => {
      const failures: unknown[] = [];
      try { await this.logWrites; await this.log.sync(); } catch (error) { failures.push(error); }
      try { await this.log.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Native worker diagnostic release failed");
    })();
  }

  private receive(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.bytes += part.length;
      if (this.bytes > 24 * 1024 * 1024) {
        this.abort(new OrbitError("BACKEND_ERROR", "Native worker response exceeds framing limit"));
        return;
      }
      this.fragments.push(part);
      if (newline < 0) return;
      try {
        const response = record(JSON.parse(Buffer.concat(this.fragments, this.bytes).toString("utf8")));
        const pending = this.pending;
        if (!pending || response.requestId !== pending.id || typeof response.ok !== "boolean")
          throw new OrbitError("BACKEND_ERROR", "Native worker response identity or shape is invalid");
        const failure = response.ok ? undefined : record(response.error);
        clearTimeout(pending.timer);
        this.pending = undefined;
        if (response.ok) pending.resolve(response.result);
        else {
          const code = typeof failure?.code === "string" ? failure.code : "BACKEND_ERROR";
          const publicMessages: Record<string, string> = {
            ACCESSIBILITY_PERMISSION_REQUIRED: "The operating system has not granted Accessibility access to the native helper's responsible application",
            SCREEN_RECORDING_PERMISSION_REQUIRED: "The operating system has not granted Screen Recording access for native window capture",
            NATIVE_PERMISSION_REQUIRED: "Native platform permission or target ownership could not be established",
            NATIVE_DELIVERY_UNCERTAIN: "The native semantic operation may have reached its target. Observe before another action; no fallback was attempted",
            CAPTURE_UNAVAILABLE: "Native window capture is unavailable; inspect the current target before another observation",
            CAPTURE_DEADLINE_EXCEEDED: "Native observation exceeded its capture deadline; inspect the current target before another observation",
            CAPTURE_GEOMETRY_CHANGED: "Native target geometry changed during capture; inspect the current target before another observation",
            TARGET_CLOSED: "The target window closed or was replaced, so nothing was delivered. Inspect native candidates for the current window before sending more.",
            TEXT_UNSUPPORTED: "Nothing was typed: the native direct-stroke implementation or keyboard keymap cannot represent the requested text. Unsafe clipboard fallback is unavailable to preserve shared selections; no paste key was sent.",
            SESSION_CLOSED: "Application control ended. Inspect native candidates; window closure is not verified.",
            OPENING_UNCERTAIN: "Application launch was attempted and delivery is uncertain. Inspect native candidates and reuse the same requestId; do not relaunch blindly.",
            STALE_REF: "The snapshot ref expired or its application state changed. Observe the exact window again before choosing another action.",
            INVALID_REF: "Use a complete snapshot-scoped ref from a current text observation.",
            FOREIGN_REF: "The snapshot ref belongs to a different window or process generation.",
            UNSUPPORTED_REF_IDENTITY: "This provider has no qualified mutation lifetime. Use a fresh image and the ordinary guarded input path.",
            SEMANTIC_UNKNOWN: "The semantic operation may have reached the application. Observe the exact target before choosing another action; no fallback was attempted.",
            SEMANTIC_NOT_DELIVERED: "The semantic operation was refused before delivery. Observe the current target before choosing another action.",
            SEMANTIC_UNSUPPORTED: "The selected control does not expose a qualified interface for this semantic operation.",
            SEMANTIC_PREPARATION_REQUIRED: "The semantic target is no longer prepared. Observe the exact window before choosing another action.",
            NATIVE_INCOMPATIBLE: "Native plugin does not match this installation or compositor. Prepare the current compositor, rebuild and reload its matching plugin.",
            NATIVE_STALE: "Native preparation no longer matches the running compositor. Run sbar-orbit native-refresh, or sbar-orbit doctor for the exact mismatch.",
            PRESENTATION_NOT_READY: "Workspace presentation was refused before display changes. Inspect monitors and wait until the requested output is unfocused with no special workspace. Retry the same requestId with unchanged parameters when ready.",
            OWNER_BUSY: "The application client is receiving owner input. Handoff leaves owner focus unchanged; wait until the client is no longer receiving owner input.",
            APPLICATION_BUSY: "The application client is already leased or native lease capacity is reached. Inspect active sessions and arrange an explicit handoff; do not stop another task or relaunch blindly.",
          };
          // The holder detail is fixed-shape text produced by the worker from the plugin's own reply.
          // HostError text is fixed in host.py and names its own repair command, so it is passed through.
          const fixed = (code === "NATIVE_STALE" || code === "NATIVE_INCOMPATIBLE") && typeof failure?.message === "string"
            && /^[\x20-\x7e]{1,300}$/.test(failure.message) && failure.message !== "Native request failed; see the private worker log" ? " Detail: " + failure.message : "";
          const holder = code === "APPLICATION_BUSY" && typeof failure?.message === "string"
            && /^Application client is already leased by lease [0-9a-f]{32} \(worker pid \d+\); [a-z ,]+(; .{0,160})?$/.test(failure.message)
            ? " " + failure.message : "";
          pending.reject(new OrbitError(code, ((Object.hasOwn(publicMessages, code) ? publicMessages[code] : undefined)
            ?? "Native request failed; inspect its private worker journal") + holder + fixed, undefined,
            code.startsWith("SEMANTIC_") ? normalizeDisposition(failure) : undefined));
          // A compositor handback ends this backend even if its worker still
          // accepts framed requests. EOF performs normal lease cleanup and the
          // existing close listener updates broker status.
          if (failure?.code === "SESSION_CLOSED")
            void this.close().catch(error => { this.recoveryFailure = error; });
        }
      } catch (error) {
        this.abort(new OrbitError("BACKEND_ERROR", "Native worker returned malformed framing or response"));
        return;
      }
      this.fragments = [];
      this.bytes = 0;
      offset = newline + 1;
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.ended || this.closing || this.failure) return Promise.reject(this.failure ?? new OrbitError("SESSION_CLOSED", "Native worker is closed"));
    if (this.queued >= 128) return Promise.reject(new OrbitError("LIMIT_REACHED", "Native worker queue is full"));
    const id = crypto.randomUUID().replaceAll("-", "");
    const bytes = Buffer.from(JSON.stringify({ requestId: id, method, params }) + "\n");
    if (bytes.length > 65536) return Promise.reject(new OrbitError("INVALID_REQUEST", "Native request exceeds framing limit"));
    this.queued++;
    const operation = this.tail.then(() => new Promise<unknown>((resolve, reject) => {
      if (this.ended || this.closing || this.failure) {
        reject(this.failure ?? new OrbitError("SESSION_CLOSED", "Native worker is closed"));
        return;
      }
      const timer = setTimeout(() => this.abort(new OrbitError("TIMEOUT", "Native worker request exceeded its deadline; delivery is uncertain")), method === "open" ? 75_000 : 20_000);
      this.pending = { id, resolve, reject, timer };
      this.stdin.write(bytes, error => { if (error) this.abort(error); });
    })).finally(() => { this.queued--; });
    // Serialization needs completion only, never a retained successful frame or native response.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private signalOwned(signal: NodeJS.Signals) {
    if (this.ended || this.child.exitCode !== null) return;
    if (this.ownsProcessGroup && this.child.pid !== undefined) {
      try { process.kill(-this.child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } else this.child.kill(signal);
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const failures: unknown[] = [];
      this.stdin.end();
      const wait = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([this.exit, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new OrbitError("TIMEOUT", "Native worker did not finish owned cleanup")), ms);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      };
      try {
        const code = await wait(15_000);
        if (code !== 0) failures.push(new OrbitError("BACKEND_ERROR", this.exitDetail ? "Native worker failed during cleanup: " + this.exitDetail : "Native worker failed during cleanup"));
      } catch (error) {
        failures.push(error);
        if (this.workerPlatform !== "win32") this.signalOwned("SIGCONT");
        this.signalOwned("SIGTERM");
        try { await wait(3_000); }
        catch (error) {
          failures.push(error);
          this.signalOwned("SIGKILL");
          try { await wait(3_000); } catch (error) { failures.push(error); }
        }
      }
      if (this.failure) failures.push(this.failure);
      this.reject(new OrbitError("SESSION_CLOSED", "Native worker is closed"));
      try { await this.releaseLog(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Native worker exchange or cleanup failed");
    })();
  }
}
