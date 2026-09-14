import { parseScrollInput, type ScrollInput } from "./scroll-input";
import { requireResourceBudget } from "./resource-budget";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OrbitError, record } from "./errors";
import { defaultViewport, parseViewport, requireInside, type Viewport } from "./viewport";
import { swayRequest } from "./sway-ipc";
import { applyAppearance, inheritedAppearance } from "./appearance";
import { usableNativeRuntime } from "./runtime-paths";
import { sweepOwnedGroup } from "./owned-group";
import { nativeRendererFromEnv, rendererBound, type NativeRenderer } from "./native-renderer";

export type NativeAction = { type: "launch"; argv: string[]; selectedFiles?: string[]; toolkit: "wayland" | "x11" }
  | { type: "pointer"; x: number; y: number } | { type: "text" | "paste"; text: string }
  | { type: "key"; key: string } | { type: "resize"; width: number; height: number }
  | { type: "window"; command: WindowCommand; tab?: number } | ScrollInput;
/** Window management inside the private display. Nothing here can reach a window on the person's desktop. */
const windowCommands = ["fullscreen", "restore", "focus", "close"] as const;
export type WindowCommand = (typeof windowCommands)[number];
export function parseNativeAction(value: unknown, size: Viewport = defaultViewport): NativeAction {
  const a = record(value);
  if (a.type === "resize") return { type: "resize", ...parseViewport(a) };
  if (a.type === "window") {
    if (!windowCommands.includes(a.command as WindowCommand))
      throw new OrbitError("UNSUPPORTED", `Window command must be one of ${windowCommands.join(", ")}`);
    if (a.tab !== undefined && (!Number.isInteger(a.tab) || Number(a.tab) < 1 || Number(a.tab) > 64))
      throw new OrbitError("INVALID_REQUEST", "Window tab requires the 1-based number reported by observe");
    return { type: "window", command: a.command as WindowCommand, ...(a.tab === undefined ? {} : { tab: Number(a.tab) }) };
  }
  if (a.type === "launch") {
    if (!Array.isArray(a.argv) || !a.argv.length || a.argv.length > 128 || a.argv.some(v => typeof v !== "string" || v.length > 4096 || v.includes("\0")) || !a.argv[0].startsWith("/"))
      throw new OrbitError("INVALID_REQUEST", "Launch requires an absolute executable and argument array");
    if (a.toolkit !== "wayland" && a.toolkit !== "x11") throw new OrbitError("INVALID_REQUEST", "Choose wayland or x11 toolkit");
    if (a.selectedFiles !== undefined && (!Array.isArray(a.selectedFiles) || a.selectedFiles.length > 32 || a.selectedFiles.some(v => typeof v !== "string" || !v.startsWith("/") || v.length > 4096 || v.includes("\0"))))
      throw new OrbitError("INVALID_REQUEST", "Select up to 32 absolute existing file paths");
    return { type: "launch", argv: a.argv, toolkit: a.toolkit, ...(a.selectedFiles !== undefined ? { selectedFiles: a.selectedFiles as string[] } : {}) };
  }
  if (a.type === "pointer") {
    if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) throw new OrbitError("INVALID_REQUEST", "Pointer coordinates must be whole pixels");
    const at = requireInside(size, Number(a.x), Number(a.y));
    return { type: "pointer", x: at.x, y: at.y };
  }
  if (a.type === "scroll") return parseScrollInput(a, size);
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
  throw new OrbitError("UNSUPPORTED", "Native backend supports launch, pointer, scroll, key, text, paste, resize and window");
}
const project = resolve(import.meta.dir, "..");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// One frame format for the private display. Measured on this output, PNG deflate added about 70 ms per frame
// on top of a 7 ms raw readback, while JPEG at quality 80 added almost nothing.
const capture = { type: "jpeg", quality: "80", mimeType: "image/jpeg" } as const;
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
/**
 * The session id a process runs in, read from /proc, or undefined for a process that is gone. The
 * fields after the command name are state, parent, group, session; the command itself can hold
 * spaces and parentheses, which is why they are read after the last ")".
 */
async function sessionOf(pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const session = Number(fields[3]);
    return Number.isInteger(session) ? session : undefined;
  } catch { return undefined; }
}

export class FedoraBackend {
  parseAction = (value: unknown) => parseNativeAction(value, this.size);
  private pointer: { x: number; y: number } | null = null;
  readonly capabilities = ["launch", "pointer", "scroll", "text", "paste", "key", "resize", "window", "observe", "pause", "resume", "stop"];
  private closed = false;
  private listeners: (() => void)[] = [];
  // Each entry is a supervisor and the group leader it reported, so a supervisor that dies without
  // reaping still leaves the group identifier that has to be swept.
  private children: { child: ChildProcessWithoutNullStreams; group?: number }[] = [];
  private compositorGroup?: number;
  private device?: ChildProcessWithoutNullStreams;
  // Where the compositor put its socket and display, learned once it is up. Typed as strings
  // rather than read back out of the environment with an assertion at every use.
  private swaySocket = "";
  private waylandDisplay = "";
  private clipboard?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  /** What the compositor was asked to draw with, and what its log says actually bound. */
  renderer: { asked: NativeRenderer["renderer"]; bound: string; device?: string; driver?: string } = { asked: "pixman", bound: "pixman" };
  private constructor(private directory: string, private env: NodeJS.ProcessEnv, private compositor: ChildProcessWithoutNullStreams, private size: Viewport) {
    compositor.once("exit", () => { void this.close(); });
    compositor.on("error", () => { void this.close(); });
  }
  static async create(size: Viewport = defaultViewport) {
  await requireResourceBudget();
    if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Fedora backend requires Linux");
    // Resolved per session rather than at import, because the runtime is shared between versions now
    // and a session started after a build should see it without the broker being restarted.
    const { runtime, executables, source: runtimeSource } = await usableNativeRuntime(project);
    if (runtimeSource === "none")
      throw new OrbitError("UNSUPPORTED", "Run the documented Fedora native bootstrap first");
    const directory = await mkdtemp("/tmp/orbit-native-");
    const env = { ...process.env };
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NOTIFY_SOCKET", "XAUTHORITY", ...inheritedAppearance])
      delete env[key];
    // Private base directories, so an application cannot restore the person's own previous session
    // or recent documents into the agent's workspace. System XDG_DATA_DIRS still resolve normally.
    const base = { XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state") };
    for (const path of Object.values(base)) await mkdir(path, { recursive: true, mode: 0o700 });
    // The person's theme, icons, cursor and fonts, so applications look the way they do on the
    // desktop. Documents, history and credentials are not part of it.
    const appearance = await applyAppearance(base.XDG_CONFIG_HOME);
    // Pixman unless the broker's environment opts into a pinned GPU renderer; see native-renderer.ts.
    const renderer = nativeRendererFromEnv();
    Object.assign(env, base, appearance.env, { XDG_RUNTIME_DIR: directory, WLR_BACKENDS: "headless", WLR_HEADLESS_OUTPUTS: "1", ...renderer.env,
      WLR_LIBINPUT_NO_DEVICES: "1", LD_LIBRARY_PATH: join(runtime, "root/usr/lib64"), NO_AT_BRIDGE: "1",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/no-session-bus` });
    const config = join(directory, "sway.conf");
    const cursor = appearance.cursor ? `seat seat0 xcursor_theme ${appearance.cursor.theme} ${appearance.cursor.size}\n` : "";
    await writeFile(config, `output HEADLESS-1 mode ${size.width}x${size.height}\nseat seat0 fallback true\n${cursor}xwayland force\ndefault_border none\nfocus_follows_mouse no\n`);
    const compositor = spawn("/usr/bin/python3", [join(project, "src/native/supervise.py"), join(directory, "compositor.json"), join(executables, "sway"), ...(renderer.renderer === "pixman" ? [] : ["-V"]), "-c", config], { env, detached: true });
    // The compositor's own output is the only evidence when a display fails to start, so keep it
    // beside the session rather than discarding it. Bounded, because sway can log per frame.
    const log = createWriteStream(join(directory, "compositor.log"), { mode: 0o600 });
    log.on("error", () => {});
    let logged = 0, head = "";
    const keep = (chunk: Buffer) => {
      if (logged < 262144 && !log.writableEnded) { logged += chunk.length; log.write(chunk); }
      // The opening of the log stays in memory too: the renderer check below reads it before the
      // write stream has necessarily reached the disk.
      if (head.length < 65536) head += chunk.toString("utf8", 0, Math.min(chunk.length, 65536 - head.length));
    };
    compositor.stdout.on("data", keep); compositor.stderr.on("data", keep);
    // close, not exit: the pipes can still hold output after the process is gone.
    compositor.once("close", () => log.end());
    const backend = new FedoraBackend(directory, env, compositor, size);
    try {
      await backend.wait(async () => {
        const files = await readdir(directory);
        const ipc = files.find(v => /^sway-ipc\..*\.sock$/.test(v));
        const display = files.find(v => /^wayland-\d+$/.test(v));
        if (!ipc || !display) return false;
        backend.swaySocket = env.SWAYSOCK = join(directory, ipc); backend.waylandDisplay = env.WAYLAND_DISPLAY = display; return true;
      });
      // The supervisor reports the compositor it started. Kept because a supervisor killed outright
      // leaves that compositor running, and the display directory is removed out from under it.
      try { backend.compositorGroup = JSON.parse(await readFile(join(directory, "compositor.json"), "utf8")).pid; } catch {}
      // Which renderer bound is read from the log, not assumed: a GPU renderer that was asked for and
      // fell over would otherwise be reported as running while every frame came from nowhere.
      const { bound, driver } = rendererBound(renderer.renderer, head);
      backend.renderer = { asked: renderer.renderer, bound, ...(renderer.device ? { device: renderer.device } : {}), ...(driver ? { driver } : {}) };
      if (bound !== renderer.renderer) throw new OrbitError("UNSUPPORTED", `The private compositor did not bind the ${renderer.renderer} renderer${renderer.device ? ` on ${renderer.device}` : ""}; see ${join(directory, "compositor.log")}`);
      // Export only the private compositor's X11 endpoint, never the host environment.
      const handoff = join(directory, "display.json");
      const code = `import os,json;json.dump({'display':os.environ.get('DISPLAY')},open('${handoff}','w'))`;
      await backend.ipc("exec", `/usr/bin/python3 -c '${code.replaceAll("'", "'\\''")}'`);
      await backend.wait(async () => {
        try { const data = JSON.parse(await readFile(handoff, "utf8")); if (!/^:\d+$/.test(data.display)) return false; env.DISPLAY = data.display; return true; }
        catch { return false; }
      });
      const device = spawn(join(runtime, "pointer"), [join(directory, backend.waylandDisplay)], { env });
      backend.device = device; device.stderr.resume();
      device.once("exit", () => { void backend.close(); });
      device.on("error", () => { void backend.close(); });
      device.stdin.on("error", () => { void backend.close(); });
      await backend.reply("ready");
      return backend;
    } catch (error) { await backend.close(); throw error; }
  }
  onClose(listener: () => void) { this.listeners.push(listener); if (this.closed) listener(); }
  get surface(): Viewport { return this.size; }
  private ensureOpen() { if (this.closed) throw new OrbitError("SESSION_CLOSED", "Native display is closed"); }
  private async wait(probe: () => Promise<boolean>, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { this.ensureOpen(); if (await probe()) return; await sleep(50); }
    throw new OrbitError("DEADLINE_EXCEEDED", "Private display operation timed out");
  }
  private async ipc(...args: string[]) {
    this.ensureOpen();
    const tree = args[0] === "-t" && args[1] === "get_tree";
    const result = await swayRequest(this.swaySocket, tree ? 4 : 0, tree ? "" : args.join(" "));
    if (Array.isArray(result) && result.some(v => v.success === false)) throw new OrbitError("BACKEND_FAILED", "Private display rejected command");
    return result;
  }
  /** The pointer helper, which every input action needs and which only exists once the display is up. */
  private input(): ChildProcessWithoutNullStreams {
    if (!this.device) throw new OrbitError("BACKEND_FAILED", "Private input helper is not running");
    return this.device;
  }
  private reply(expected: string): Promise<void> {
    const device = this.input();
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
    const action = this.parseAction(value);
    this.ensureOpen();
    if (action.type === "resize") {
      // The private display has one output, so resizing it is what gives an application more room.
      // The pointer position is kept only if it still lands on the new surface.
      await this.ipc("output", "HEADLESS-1", "mode", "--custom", `${action.width}x${action.height}`);
      this.size = { width: action.width, height: action.height };
      if (this.pointer && (this.pointer.x >= action.width || this.pointer.y >= action.height)) this.pointer = null;
      return { width: action.width, height: action.height };
    }
    if (action.type === "window") {
      const target = action.tab === undefined ? "" : `[con_id=${await this.windowAt(action.tab)}] `;
      const command = { fullscreen: "fullscreen enable", restore: "fullscreen disable", focus: "focus", close: "kill" }[action.command];
      await this.ipc(`${target}${command}`);
      return { applied: true, command: action.command, ...(action.tab === undefined ? {} : { tab: action.tab }) };
    }
    if (action.type === "launch") {
      if (this.children.length >= 32) throw new OrbitError("LIMIT_REACHED", "Native session application limit reached");
      const [executable] = action.argv;
      if (!executable) throw new OrbitError("INVALID_REQUEST", "Launch needs an executable");
      if (!await Bun.file(executable).exists()) throw new OrbitError("INVALID_REQUEST", "Executable does not exist");
      const pidFile = join(this.directory, `app-${crypto.randomUUID()}.json`);
      const child = spawn("/usr/bin/python3", [join(project, "src/native/supervise.py"), pidFile, "--selected-files", JSON.stringify(action.selectedFiles ?? []), executable, ...action.argv.slice(1)], { env: { ...this.env, GDK_BACKEND: action.toolkit }, detached: true });
      child.on("error", () => {}); child.stdout.resume(); child.stderr.resume();
      const supervised: { child: ChildProcessWithoutNullStreams; group?: number } = { child };
      this.children.push(supervised);
      let applicationPid: number | undefined;
      let selectedFiles: string[] = [];
      let mapped: number | undefined;
      try {
      await this.wait(async () => {
        let report: { pid?: number; selectedFiles?: string[]; error?: { code: string; message: string } } | undefined;
        try { report = JSON.parse(await readFile(pidFile, "utf8")); } catch {}
        if (report?.error) throw new OrbitError(report.error.code, report.error.message);
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new OrbitError("BACKEND_FAILED", "Application exited before mapping");
        if (!report?.pid) return false;
        applicationPid = report.pid; selectedFiles = report.selectedFiles ?? [];
        const tree = await this.ipc("-t", "get_tree");
        // The window can belong to a descendant rather than to the process the supervisor started:
        // /usr/bin/libreoffice is a script whose oosplash forks soffice.bin, and the window is
        // soffice.bin's. Measured 14 September 2026: Writer mapped in a few seconds and this wait
        // still ran out at 30, because no window carried the supervised pid. The supervisor starts
        // the application in a new session, so every descendant shares its session id, and that is
        // what a window is matched on. A window of some other session on this display is nobody's.
        const candidates: { pid: number; id: number }[] = [];
        const collect = (node: any) => {
          if (node.pid && node.visible) candidates.push({ pid: node.pid, id: node.id });
          for (const next of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) collect(next);
        };
        collect(tree);
        for (const candidate of candidates) {
          if (candidate.pid === applicationPid || await sessionOf(candidate.pid) === applicationPid) { mapped = candidate.id; return true; }
        }
        return false;
      // Electron applications on a software-rendered display take well over ten seconds to map.
      }, 30000);
      supervised.group = applicationPid;
      // A supervisor can die on its own, without the broker and without the display. Nothing else
      // notices, because the application it owned is not a child of this process and keeps running.
      child.once("exit", () => { void this.reap(supervised); });
      await this.ipc(`[con_id=${mapped}]`, "focus");
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
      this.input().stdin.write("paste\n");
      await acknowledgement;
      return { applied: true, clipboard: "session", shortcut: "Ctrl+V" };
    }
    const acknowledgement = this.reply("ok");
    this.input().stdin.write(action.type === "pointer" ? `${action.x} ${action.y}\n` : action.type === "scroll" ? `scroll ${action.x} ${action.y} ${action.deltaY}\n` : action.type === "key" ? `key ${action.key}\n` : `text ${action.text}\n`);
    await acknowledgement;
    if (action.type === "pointer" || action.type === "scroll") this.pointer = { x: action.x, y: action.y };
    return { applied: true };
  }
  control(value: unknown) {
    const input = record(value);
    if (["text", "paste", "scroll", "resize", "window"].includes(String(input.type))) return this.act(this.parseAction(input));
    if (input.type !== "click") throw new OrbitError("UNSUPPORTED", "Native manual control supports clicks, vertical scrolling, ASCII text, Unicode paste, resize and window commands");
    const at = requireInside(this.size, input.x, input.y);
    return this.act({ type: "pointer", x: Math.floor(at.x), y: Math.floor(at.y) });
  }
  /** Windows of the private display, in tree order, so a person and an agent number them the same way. */
  private windows(tree: any): { id: number; title: string; pid: number; focused: boolean }[] {
    const found: { id: number; title: string; pid: number; focused: boolean }[] = [];
    const walk = (node: any) => {
      if (node.pid) found.push({ id: node.id, title: String(node.name ?? "Window").slice(0, 160), pid: node.pid, focused: !!node.focused });
      for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) walk(child);
    };
    walk(tree);
    return found;
  }
  private async windowAt(tab: number): Promise<number> {
    const windows = this.windows(await this.ipc("-t", "get_tree"));
    const window = windows[tab - 1];
    if (!window) throw new OrbitError("INVALID_REQUEST", `Window ${tab} is not open; observe reports ${windows.length} open`);
    return window.id;
  }
  /** Focused window and window list from the compositor tree, no frame. Measured at under a millisecond. */
  async presence() {
    this.ensureOpen();
    const windows = this.windows(await this.ipc("-t", "get_tree"));
    const app = windows.find(window => window.focused);
    return { title: String(app?.title ?? "Private desktop").slice(0, 160), location: "Orbit private display", pointer: this.pointer,
      pageCount: windows.length, pageIndex: app ? windows.indexOf(app) + 1 : 0,
      tabs: windows.map((window, index) => ({ tab: index + 1, label: window.title, active: window.focused })) };
  }
  async observe() {
    const capturedAt = Date.now();
    this.ensureOpen();
    const image = await command(["/usr/bin/grim", "-o", "HEADLESS-1", "-t", capture.type, "-q", capture.quality, "-"], this.env);
    return { mimeType: capture.mimeType, image: image.toString("base64"), capturedAt, width: this.size.width, height: this.size.height, presence: await this.presence() };
  }
  /** Drop a supervisor that has exited and terminate whatever it left behind. */
  private async reap(supervised: { child: ChildProcessWithoutNullStreams; group?: number }) {
    this.children = this.children.filter(entry => entry !== supervised);
    if (supervised.group !== undefined) await sweepOwnedGroup(supervised.group, this.directory);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const supervised = [...this.children];
      const children = [...supervised.map(entry => entry.child), ...(this.device ? [this.device] : []), ...(this.clipboard ? [this.clipboard] : []), this.compositor];
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
        try { await exited; } finally { clearTimeout(timer); }
      }));
      // A live supervisor reaps its own tree on the way out, so by here every group is normally
      // gone already. The exception is the supervisor that was killed rather than asked, and that
      // is the one case where an application would otherwise survive the display it was given.
      for (const group of [...supervised.map(entry => entry.group), this.compositorGroup])
        if (group !== undefined) await sweepOwnedGroup(group, this.directory);
      // The runtime directory lives on tmpfs, and tmpfs pages are charged to the cgroup that wrote
      // them. Left behind, closed sessions kept filling the shared memory budget until the kernel
      // throttled everything that was still running.
      await rm(this.directory, { recursive: true, force: true }).catch(() => {});
      for (const listener of this.listeners) listener();
    })();
    return this.closing;
  }
}
