import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { open, mkdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { OrbitError, record } from "./errors";
import { requireResourceBudget } from "./resource-budget";

export type NativeOptions = { planPath: string; controlDirectory: string; appearanceDirectory?: string };

export function nativeOptionsFromEnv(): NativeOptions | undefined {
  const planPath = process.env.ORBIT_NATIVE_PLAN, controlDirectory = process.env.ORBIT_NATIVE_CONTROL;
  const appearanceDirectory = process.env.ORBIT_NATIVE_APPEARANCE;
  if (planPath === undefined && controlDirectory === undefined && appearanceDirectory === undefined) return undefined;
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

  private constructor(readonly child: ChildProcess, private stdin: Writable, private stdout: Readable, private log: FileHandle) {
    this.exit = new Promise(resolve => child.once("close", async code => {
      this.ended = true;
      this.reject(this.failure ?? new OrbitError("BACKEND_ERROR", "Native worker closed"));
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

  static async create(directory: string, options: NativeOptions, entry = ["/usr/bin/python3", join(import.meta.dir, "native/session_worker.py")]) {
    await requireResourceBudget();
    if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native broker requires Linux");
    if (!isAbsolute(options.planPath) || !isAbsolute(options.controlDirectory))
      throw new OrbitError("INVALID_REQUEST", "Native configuration paths must be absolute");
    await mkdir(directory, { mode: 0o700 });
    const log = await open(join(directory, "worker.log"), "wx", 0o600);
    try {
      const child = spawn(entry[0] ?? "/usr/bin/python3", [...entry.slice(1), directory, options.controlDirectory, options.planPath],
        { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", log.fd] });
      if (!child.stdin || !child.stdout) {
        child.kill("SIGTERM");
        throw new OrbitError("BACKEND_ERROR", "Native worker did not expose its framed streams");
      }
      return new NativeWorker(child, child.stdin, child.stdout, log);
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
          pending.reject(new OrbitError(typeof failure?.code === "string" ? failure.code : "BACKEND_ERROR",
            "Native request failed; inspect its private worker journal"));
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
      const timer = setTimeout(() => this.abort(new OrbitError("TIMEOUT", "Native worker request exceeded its deadline; delivery is uncertain")), 20_000);
      this.pending = { id, resolve, reject, timer };
      this.stdin.write(bytes, error => { if (error) this.abort(error); });
    })).finally(() => { this.queued--; });
    this.tail = operation.catch(() => {});
    return operation;
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
        if (code !== 0) failures.push(new OrbitError("BACKEND_ERROR", "Native worker failed during cleanup"));
      } catch (error) {
        failures.push(error);
        this.child.kill("SIGCONT");
        this.child.kill("SIGTERM");
        try { await wait(3_000); }
        catch (error) {
          failures.push(error);
          this.child.kill("SIGKILL");
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
