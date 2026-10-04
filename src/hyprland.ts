import { OrbitError, record } from "./errors";
import { NativeWorker, type NativeOptions } from "./native-worker";
import { defaultViewport, type Viewport } from "./viewport";
import { createWorkspaceDirectory } from "./workspace-storage";
import { requireResourceBudget } from "./resource-budget";
import { loadNativeAppearance } from "./native-appearance";
import { basename, join } from "node:path";
import { copyFile, mkdir, rm, chmod, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";

type Target = { appId: string; windowId: string };
type NativeAction = { type: string; [key: string]: unknown };
type Window = Target & { title: string; width: number; height: number };

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value))
    throw new OrbitError("INVALID_REQUEST", "Native targets require generated application/window identifiers");
  return value;
}

function target(value: Record<string, unknown>): Target {
  return { appId: identifier(value.appId), windowId: identifier(value.windowId) };
}

/** The compositor is fixed at broker startup. All application targets are worker-owned handles. */
export class NativeBackend {
  readonly capabilities = ["launch", "windows", "cursor", "move", "click", "scroll", "text", "key", "state", "hide-cursor", "observe", "close-application", "pause", "resume", "stop"];
  private applications = new Set<string>();
  private windows = new Map<string, Window>();
  private selected?: Target;
  private size = defaultViewport;
  private pointer: { x: number; y: number } | null = null;
  private scales = new Map<string, { x: number; y: number }>();

  private closing?: Promise<void>;
  private constructor(private worker: NativeWorker, private directory: string, private options: NativeOptions,
    private appearance: Readonly<Record<string, string>>) {}

  static async create(_profile: string, options: NativeOptions) {
    await requireResourceBudget();
    if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native broker requires Linux");
    // Application bus socket paths must stay below the Unix path limit, independent of project paths.
    const directory = await createWorkspaceDirectory("native", "/var/tmp/orbit-native-" + process.getuid?.());
    let worker: NativeWorker;
    let appearance: Readonly<Record<string, string>> = Object.freeze({});
    try {
      if (options.appearanceDirectory !== undefined) appearance = await loadNativeAppearance(options.appearanceDirectory);
      worker = await NativeWorker.create(join(directory, "worker"), options);
    }
    catch (error) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Native startup and directory cleanup failed"); }
      throw error;
    }
    const backend = new NativeBackend(worker, directory, options, appearance);
    try {
      const response = record(await worker.request("status", {}));
      if (response.ready !== true) throw new OrbitError("BACKEND_ERROR", "Native worker did not become ready");
      return backend;
    } catch (error) {
      try { await worker.close(); await rm(directory, { recursive: true, force: true }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Native startup and cleanup failed"); }
      throw error;
    }
  }

  get surface(): Viewport { return this.size; }
  onClose(listener: () => void) { this.worker.onClose(listener); }
  close() {
    return this.closing ??= (async () => {
      // Failed worker cleanup retains its private workspace for diagnosis.
      await this.worker.close();
      const logs = join(this.options.controlDirectory, "broker-logs");
      await mkdir(logs, { recursive: true, mode: 0o700 });
      const retained = join(logs, basename(this.directory));
      await mkdir(retained, { mode: 0o700 });
      const save = async (source: string, name: string) => {
        const info = await lstat(source);
        if (!info.isFile() || info.nlink !== 1) throw new OrbitError("BACKEND_ERROR", "Native diagnostic must be an unlinked regular file");
        const destination = join(retained, name);
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        await chmod(destination, 0o600);
      };
      await save(join(this.directory, "worker/worker.log"), "worker.log");
      for (const entry of await readdir(join(this.directory, "worker"), { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("native-app-")) continue;
        for (const file of await readdir(join(this.directory, "worker", entry.name))) {
          if (file === "worker.log" || /^capture-[a-f0-9]{32}\.log$/.test(file))
            await save(join(this.directory, "worker", entry.name, file), entry.name + "-" + file);
        }
      }
      await rm(this.directory, { recursive: true, force: true });
    })();
  }

  parseAction(value: unknown): NativeAction {
    const input = record(value);
    if (typeof input.type !== "string") throw new OrbitError("INVALID_REQUEST", "Native action requires a type");
    const fields: Record<string, string[]> = {
      launch: ["argv", "configuration"], windows: ["appId"], "close-application": ["appId"],
      cursor: ["appId", "windowId", "x", "y"], move: ["appId", "windowId", "x", "y"],
      click: ["appId", "windowId", "x", "y", "button"], scroll: ["appId", "windowId", "x", "y", "dy"],
      text: ["appId", "windowId", "text"], key: ["appId", "windowId", "key"],
      state: ["appId", "windowId"], "hide-cursor": ["appId", "windowId"],
    };
    const allowed = fields[input.type];
    if (!allowed || Object.keys(input).some(key => key !== "type" && !allowed.includes(key)))
      throw new OrbitError("INVALID_REQUEST", "Unknown native action or unexpected fields");
    if (input.type === "launch") {
      if (!Array.isArray(input.argv) || !input.argv.length || input.argv.some(value => typeof value !== "string" || value.includes("\0")))
        throw new OrbitError("INVALID_REQUEST", "Native launch requires an argv array");
    } else {
      identifier(input.appId);
      if (allowed.includes("windowId")) target(input);
    }
    // Full shape and coordinate validation runs in the worker before admission or delivery.
    return { ...input, type: input.type };
  }

  async act(value: unknown): Promise<unknown> {
    const action = this.parseAction(value);
    if (action.type === "launch") {
      const configuration = action.configuration === undefined ? undefined : record(action.configuration);
      const result = record(await this.worker.request("launch", {
        argv: action.argv,
        ...(configuration === undefined && !Object.keys(this.appearance).length ? {} : {
          configuration: { ...this.appearance, ...configuration },
        }),
      }));
      this.applications.add(identifier(result.appId));
      return result;
    }
    const appId = identifier(action.appId);
    if (!this.applications.has(appId)) throw new OrbitError("INVALID_REQUEST", "Native application belongs to another session or is closed");
    if (action.type === "close-application") {
      const result = await this.worker.request("close-application", { appId });
      this.applications.delete(appId);
      for (const [key, window] of this.windows) if (window.appId === appId) {
        this.windows.delete(key); this.scales.delete(key);
      }
      if (this.selected?.appId === appId) { this.selected = undefined; this.pointer = null; }
      return result;
    }
    const result = await this.worker.request("act", action);
    if (action.type === "windows") {
      const reply = record(result);
      if (!Array.isArray(reply.windows)) throw new OrbitError("BACKEND_ERROR", "Native worker returned invalid window metadata");
      const owned = reply.windows.map(value => {
        const window = record(value), identity = target(window);
        if (identity.appId !== appId || typeof window.title !== "string" || typeof window.width !== "number" || typeof window.height !== "number")
          throw new OrbitError("BACKEND_ERROR", "Native worker returned a foreign or invalid window");
        return { ...identity, title: window.title, width: window.width, height: window.height };
      });
      for (const [key, window] of this.windows) if (window.appId === appId) this.windows.delete(key);
      for (const window of owned) this.windows.set(window.windowId, window);
      return result;
    }
    this.selected = target(action);
    if (["cursor", "move", "click", "scroll"].includes(action.type)) {
      const scale = this.scales.get(this.selected.windowId) ?? { x: 1, y: 1 };
      this.pointer = { x: Number(action.x) * scale.x, y: Number(action.y) * scale.y };
    }
    if (action.type === "hide-cursor") this.pointer = null;
    return result;
  }

  control(value: unknown) { return this.act(value); }

  async presence() {
    const entries = [...this.windows.values()];
    const selected = this.selected && this.windows.get(this.selected.windowId);
    return { title: selected?.title ?? "Native target not selected", location: "Orbit native scoped applications",
      pointer: this.pointer, pageCount: entries.length, pageIndex: selected ? entries.indexOf(selected) + 1 : 0,
      tabs: entries.map((window, index) => ({ tab: index + 1, label: window.title, active: window.windowId === this.selected?.windowId,
        appId: window.appId, windowId: window.windowId })), sampled: "acknowledged metadata" };
  }

  async observe(value?: unknown) {
    const selected = value === undefined ? this.selected : target(record(value));
    if (!selected || !this.applications.has(selected.appId))
      throw new OrbitError("INVALID_REQUEST", "Observe requires an explicit owned native target");
    const frame = record(await this.worker.request("act", { type: "observe", ...selected }));
    if (frame.appId !== selected.appId || frame.windowId !== selected.windowId || frame.mimeType !== "image/png"
        || typeof frame.image !== "string" || typeof frame.width !== "number" || typeof frame.height !== "number")
      throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid target frame");
    this.selected = selected;
    this.size = { width: frame.width, height: frame.height };
    this.scales.set(selected.windowId, { x: frame.width / Number(frame.surfaceWidth), y: frame.height / Number(frame.surfaceHeight) });
    const point = frame.pointer === null ? null : record(frame.pointer);
    this.pointer = point === null ? null : { x: Number(point.x) * frame.width / Number(frame.surfaceWidth),
      y: Number(point.y) * frame.height / Number(frame.surfaceHeight) };
    return { ...frame, presence: await this.presence() };
  }
}
