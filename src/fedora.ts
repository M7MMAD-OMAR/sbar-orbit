import { requireResourceBudget } from "./resource-budget";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OrbitError, record } from "./errors";
import { swayRequest } from "./sway-ipc";

export type NativeAction = { type: "launch"; argv: string[]; selectedFiles?: string[]; toolkit: "wayland" | "x11" }
  | { type: "pointer"; x: number; y: number } | { type: "text" | "paste"; text: string }
  | { type: "key"; key: string } | { type: "scroll"; x: number; y: number; deltaY: number };
export function parseNativeAction(value: unknown): NativeAction {
  const a = record(value);
  if (a.type === "launch") {
    if (!Array.isArray(a.argv) || !a.argv.length || a.argv.length > 128 || a.argv.some(v => typeof v !== "string" || v.length > 4096 || v.includes("\0")) || !a.argv[0].startsWith("/"))
      throw new OrbitError("INVALID_REQUEST", "Launch requires an absolute executable and argument array");
    if (a.toolkit !== "wayland" && a.toolkit !== "x11") throw new OrbitError("INVALID_REQUEST", "Choose wayland or x11 toolkit");
    if (a.selectedFiles !== undefined && (!Array.isArray(a.selectedFiles) || a.selectedFiles.length > 32 || a.selectedFiles.some(v => typeof v !== "string" || !v.startsWith("/") || v.length > 4096 || v.includes("\0"))))
      throw new OrbitError("INVALID_REQUEST", "Select up to 32 absolute existing file paths");
    return { type: "launch", argv: a.argv, toolkit: a.toolkit, ...(a.selectedFiles !== undefined ? { selectedFiles: a.selectedFiles as string[] } : {}) };
  }
  if (a.type === "pointer") {
    if (!Number.isInteger(a.x) || !Number.isInteger(a.y) || Number(a.x) < 0 || Number(a.y) < 0 || Number(a.x) >= 1280 || Number(a.y) >= 800)
      throw new OrbitError("INVALID_REQUEST", "Coordinates outside session viewport");
    return { type: "pointer", x: Number(a.x), y: Number(a.y) };
  }
  if (a.type === "scroll") {
    if (!Number.isInteger(a.x) || !Number.isInteger(a.y) || Number(a.x) < 0 || Number(a.x) >= 1280 || Number(a.y) < 0 || Number(a.y) >= 800
      || !Number.isInteger(a.deltaY) || Number(a.deltaY) === 0 || Math.abs(Number(a.deltaY)) > 20)
      throw new OrbitError("INVALID_REQUEST", "Scroll requires viewport coordinates and nonzero integer wheel steps from -20 to 20");
    return { type: "scroll", x: Number(a.x), y: Number(a.y), deltaY: Number(a.deltaY) };
  }
  if (a.type === "text") {
    if (typeof a.text !== "string" || a.text.length > 2048 || /[^\x20-\x7e]/.test(a.text))
      throw new OrbitError("UNSUPPORTED", "Native text currently supports up to 2048 printable ASCII characters");
    return { type: "text", text: a.text };
  }
  if (a.type === "paste") {
    if (typeof a.text !== "string" || a.text.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(a.text) || !a.text.isWellFormed())
      throw new OrbitError("INVALID_REQUEST", "Paste requires up to 2048 well-formed Unicode code units without control characters other than tab and newlines");
    return { type: "paste", text: a.text };
  }
  if (a.type === "key") {
    if (!["Ctrl+A", "Ctrl+S", "Ctrl+O", "Ctrl+L", "Enter", "Tab", "Escape"].includes(String(a.key)))
      throw new OrbitError("UNSUPPORTED", "Unsupported native key");
    return { type: "key", key: String(a.key) };
  }
  throw new OrbitError("UNSUPPORTED", "Native backend supports launch, pointer, scroll, key, text and paste");
}
const project = resolve(import.meta.dir, "..");
const runtime = join(project, ".runtime/sway");
const executables = join(runtime, "root/usr/bin");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function command(argv: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [out, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) {
      const error = new OrbitError("BACKEND_FAILED", "Private display command failed");
      error.cause = new Error(stderr || `Command exited with status ${code}`);
      throw error;
    }
    return Buffer.from(out);
  } finally { clearTimeout(timeout); }
}
export class FedoraBackend {
  parseAction = parseNativeAction;
  readonly capabilities = ["launch", "pointer", "scroll", "text", "paste", "key", "observe", "pause", "resume", "stop"];
  private closed = false;
  private listeners: (() => void)[] = [];
  private children: ChildProcessWithoutNullStreams[] = [];
  private device?: ChildProcessWithoutNullStreams;
  private clipboard?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  private constructor(private directory: string, private env: NodeJS.ProcessEnv, private compositor: ChildProcessWithoutNullStreams) {
    compositor.once("exit", () => { void this.close(); });
    compositor.on("error", () => { void this.close(); });
  }
  static async create() {
  await requireResourceBudget();
    if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Fedora backend requires Linux");
    if (!await Bun.file(join(executables, "sway")).exists() || !await Bun.file(join(runtime, "pointer")).exists())
      throw new OrbitError("UNSUPPORTED", "Run the documented Fedora native bootstrap first");
    const directory = await mkdtemp("/tmp/orbit-native-");
    const env = { ...process.env };
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NOTIFY_SOCKET", "XAUTHORITY"])
      delete env[key];
    Object.assign(env, { XDG_RUNTIME_DIR: directory, WLR_BACKENDS: "headless", WLR_HEADLESS_OUTPUTS: "1", WLR_RENDERER: "pixman",
      WLR_LIBINPUT_NO_DEVICES: "1", LD_LIBRARY_PATH: join(runtime, "root/usr/lib64"), NO_AT_BRIDGE: "1",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/no-session-bus` });
    const config = join(directory, "sway.conf");
    await writeFile(config, "output HEADLESS-1 mode 1280x800\nseat seat0 fallback true\nxwayland force\ndefault_border none\nfocus_follows_mouse no\n");
    const compositor = spawn("/usr/bin/python3", [join(project, "src/native/supervise.py"), join(directory, "compositor.json"), join(executables, "sway"), "-c", config], { env, detached: true });
    compositor.stdout.resume(); compositor.stderr.resume();
    const backend = new FedoraBackend(directory, env, compositor);
    try {
      await backend.wait(async () => {
        const files = await readdir(directory);
        const ipc = files.find(v => /^sway-ipc\..*\.sock$/.test(v));
        const display = files.find(v => /^wayland-\d+$/.test(v));
        if (!ipc || !display) return false;
        env.SWAYSOCK = join(directory, ipc); env.WAYLAND_DISPLAY = display; return true;
      });
      // Export only the private compositor's X11 endpoint, never the host environment.
      const handoff = join(directory, "display.json");
      const code = `import os,json;json.dump({'display':os.environ.get('DISPLAY')},open('${handoff}','w'))`;
      await backend.ipc("exec", `/usr/bin/python3 -c '${code.replaceAll("'", "'\\''")}'`);
      await backend.wait(async () => {
        try { const data = JSON.parse(await readFile(handoff, "utf8")); if (!/^:\d+$/.test(data.display)) return false; env.DISPLAY = data.display; return true; }
        catch { return false; }
      });
      const device = spawn(join(runtime, "pointer"), [join(directory, env.WAYLAND_DISPLAY!)], { env });
      backend.device = device; device.stderr.resume();
      device.once("exit", () => { void backend.close(); });
      device.on("error", () => { void backend.close(); });
      device.stdin.on("error", () => { void backend.close(); });
      await backend.reply("ready");
      return backend;
    } catch (error) { await backend.close(); throw error; }
  }
  onClose(listener: () => void) { this.listeners.push(listener); if (this.closed) listener(); }
  private ensureOpen() { if (this.closed) throw new OrbitError("SESSION_CLOSED", "Native display is closed"); }
  private async wait(probe: () => Promise<boolean>) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { this.ensureOpen(); if (await probe()) return; await sleep(50); }
    throw new OrbitError("DEADLINE_EXCEEDED", "Private display operation timed out");
  }
  private async ipc(...args: string[]) {
    this.ensureOpen();
    const tree = args[0] === "-t" && args[1] === "get_tree";
    const result = await swayRequest(this.env.SWAYSOCK!, tree ? 4 : 0, tree ? "" : args.join(" "));
    if (Array.isArray(result) && result.some(v => v.success === false)) throw new OrbitError("BACKEND_FAILED", "Private display rejected command");
    return result;
  }
  private reply(expected: string): Promise<void> {
    const device = this.device!;
    return new Promise((resolve, reject) => {
      let buffer = "";
      const cleanup = () => { clearTimeout(timer); device.stdout.off("data", data); device.off("exit", fail); device.off("error", fail); };
      const fail = () => { cleanup(); reject(new OrbitError("BACKEND_FAILED", "Private input helper failed")); };
      const data = (chunk: Buffer) => { buffer += chunk.toString(); if (buffer.includes("\n")) { cleanup(); buffer.trim() === expected ? resolve() : reject(new OrbitError("BACKEND_FAILED", "Unexpected input acknowledgement")); } };
      const timer = setTimeout(fail, 5000);
      device.stdout.on("data", data); device.once("exit", fail); device.once("error", fail);
    });
  }
  async act(value: unknown): Promise<unknown> {
    const action = parseNativeAction(value);
    this.ensureOpen();
    if (action.type === "launch") {
      if (this.children.length >= 32) throw new OrbitError("LIMIT_REACHED", "Native session application limit reached");
      const executable = action.argv[0]!;
      if (!await Bun.file(executable).exists()) throw new OrbitError("INVALID_REQUEST", "Executable does not exist");
      const pidFile = join(this.directory, `app-${crypto.randomUUID()}.json`);
      const child = spawn("/usr/bin/python3", [join(project, "src/native/supervise.py"), pidFile, "--selected-files", JSON.stringify(action.selectedFiles ?? []), executable, ...action.argv.slice(1)], { env: { ...this.env, GDK_BACKEND: action.toolkit }, detached: true });
      child.on("error", () => {}); child.stdout.resume(); child.stderr.resume(); this.children.push(child);
      let applicationPid: number | undefined;
      let selectedFiles: string[] = [];
      try {
      await this.wait(async () => {
        let report: { pid?: number; selectedFiles?: string[]; error?: { code: string; message: string } } | undefined;
        try { report = JSON.parse(await readFile(pidFile, "utf8")); } catch {}
        if (report?.error) throw new OrbitError(report.error.code, report.error.message);
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new OrbitError("BACKEND_FAILED", "Application exited before mapping");
        if (!report?.pid) return false;
        applicationPid = report.pid; selectedFiles = report.selectedFiles ?? [];
        const tree = await this.ipc("-t", "get_tree");
        const find = (node: any): boolean => (node.pid === applicationPid && node.visible) || [...(node.nodes ?? []), ...(node.floating_nodes ?? [])].some(find);
        return find(tree);
      });
      await this.ipc(`[pid=${applicationPid}]`, "focus");
      await sleep(500);
      return { pid: applicationPid, applied: true, selectedFiles };
      } catch (error) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
          child.stdin.end(); await exited;
        }
        throw error;
      }
    }
    if (action.type === "paste") {
      if (!await Bun.file("/usr/bin/wl-copy").exists() || !await Bun.file("/usr/bin/wl-paste").exists())
        throw new OrbitError("UNSUPPORTED", "Native Unicode paste requires wl-clipboard");
      if (this.clipboard) {
        const previous = this.clipboard;
        if (previous.exitCode === null && previous.signalCode === null) {
          const exited = new Promise<void>(resolve => previous.once("exit", () => resolve()));
          previous.kill("SIGTERM");
          const timer = setTimeout(() => previous.kill("SIGKILL"), 4000);
          try { await exited; } finally { clearTimeout(timer); }
        }
      }
      this.ensureOpen();
      const clipboard = spawn("/usr/bin/wl-copy", ["--foreground", "--type", "text/plain;charset=utf-8"], { env: this.env });
      this.clipboard = clipboard;
      clipboard.stdout.resume(); clipboard.stderr.resume();
      let failure: Error | undefined;
      clipboard.on("error", error => { failure = error; });
      clipboard.stdin.on("error", error => { failure = error; });
      clipboard.stdin.end(action.text);
      await this.wait(async () => {
        if (failure || clipboard.exitCode !== null || clipboard.signalCode !== null)
          throw new OrbitError("BACKEND_FAILED", "Private clipboard provider failed");
        try { return (await command(["/usr/bin/wl-paste", "--no-newline", "--type", "text/plain;charset=utf-8"], this.env)).toString() === action.text; }
        catch { return false; }
      });
      const acknowledgement = this.reply("ok");
      this.device!.stdin.write("paste\n");
      await acknowledgement;
      return { applied: true, clipboard: "session", shortcut: "Ctrl+V" };
    }
    const acknowledgement = this.reply("ok");
    this.device!.stdin.write(action.type === "pointer" ? `${action.x} ${action.y}\n` : action.type === "scroll" ? `scroll ${action.x} ${action.y} ${action.deltaY}\n` : action.type === "key" ? `key ${action.key}\n` : `text ${action.text}\n`);
    await acknowledgement;
    return { applied: true };
  }
  control(value: unknown) {
    const input = record(value);
    if (input.type === "text" || input.type === "paste") return this.act(parseNativeAction(input));
    if (input.type !== "click") throw new OrbitError("UNSUPPORTED", "Native manual control supports clicks, ASCII text and Unicode paste");
    if (typeof input.x !== "number" || typeof input.y !== "number" || !Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= 1280 || input.y >= 800)
      throw new OrbitError("INVALID_REQUEST", "Coordinates outside session viewport");
    return this.act({ type: "pointer", x: Math.floor(input.x), y: Math.floor(input.y) });
  }
  async observe() {
    const capturedAt = Date.now();
    this.ensureOpen();
    const image = await command(["/usr/bin/grim", "-o", "HEADLESS-1", "-"], this.env);
    return { mimeType: "image/png", image: image.toString("base64"), capturedAt, width: 1280, height: 800 };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const children = [...this.children, ...(this.device ? [this.device] : []), ...(this.clipboard ? [this.clipboard] : []), this.compositor];
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
        try { await exited; } finally { clearTimeout(timer); }
      }));
      for (const listener of this.listeners) listener();
    })();
    return this.closing;
  }
}
