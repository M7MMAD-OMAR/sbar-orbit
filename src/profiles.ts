import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open, lstat, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { OrbitError } from "./errors";

/** An account snapshot lease, never a reusable live browser profile. */
export class AccountLease {
  private released?: Promise<void>;
  private constructor(readonly name: string, private directory: string, private holder: ChildProcessWithoutNullStreams) {}
  static async acquire(root: string, name: unknown) {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
      throw new OrbitError("INVALID_REQUEST", "Account name must contain lowercase letters, digits, underscores or hyphens");
    if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Account leases currently require Linux flock");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = join(root, name);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    for (const path of [root, directory]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new OrbitError("INVALID_REQUEST", "Account storage must be a private directory");
    }
    const lock = join(directory, "lease.lock");
    const file = await open(lock, "a", 0o600); await file.close();
    const holder = spawn("/usr/bin/flock", ["-n", "-E", "73", "-F", lock, "/usr/bin/cat"]);
    holder.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        const cleanup = () => { clearTimeout(timer); holder.stdout.off("data", data); holder.off("exit", exit); holder.off("error", error); };
        const error = () => { cleanup(); reject(new OrbitError("UNSUPPORTED", "Account lock helper unavailable")); };
        const exit = (code: number | null) => { cleanup(); reject(new OrbitError(code === 73 ? "PROFILE_BUSY" : "BACKEND_FAILED", code === 73 ? "Account is in use by another session" : "Account lock failed")); };
        const data = (chunk: Buffer) => { buffer += chunk.toString(); if (buffer === "ready\n") { cleanup(); resolve(); } };
        const timer = setTimeout(() => { cleanup(); reject(new OrbitError("DEADLINE_EXCEEDED", "Account lock timed out")); }, 3000);
        holder.stdout.on("data", data); holder.once("exit", exit); holder.once("error", error);
        holder.stdin.on("error", () => {}); holder.stdin.write("ready\n");
      });
      return new AccountLease(name, directory, holder);
    } catch (error) { holder.kill(); throw error; }
  }
  onLost(listener: () => void) { this.holder.on("exit", () => { if (!this.released) listener(); }); }
  private ensureHeld() {
    if (this.released || this.holder.exitCode !== null || this.holder.signalCode !== null) throw new OrbitError("SESSION_CLOSED", "Account lease is no longer held");
  }
  async restore() {
    this.ensureHeld();
    try { return JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new OrbitError("ACCOUNT_STATE_INVALID", "Saved account state could not be loaded"); }
  }
  async save(value: unknown) {
    this.ensureHeld();
    const temporary = join(this.directory, `state-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    this.ensureHeld();
    await rename(temporary, join(this.directory, "state.json"));
  }
  release(): Promise<void> {
    if (this.released) return this.released;
    this.released = new Promise(resolve => {
      if (this.holder.exitCode !== null || this.holder.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => this.holder.kill("SIGKILL"), 1000);
      this.holder.once("exit", () => { clearTimeout(timer); resolve(); });
      this.holder.stdin.end();
    });
    return this.released;
  }
}
