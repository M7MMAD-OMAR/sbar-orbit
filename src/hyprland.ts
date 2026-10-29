import { OrbitError, record } from "./errors";
import { resolveInstalledApplication } from "./application-launch";
import { requireNativeAdapter } from "./native-availability";
import { NativeWorker, type NativeOptions } from "./native-worker";
import { defaultViewport, type Viewport } from "./viewport";
import { createWorkspaceDirectory } from "./workspace-storage";
import { requireResourceBudget } from "./resource-budget";
import { basename, join } from "node:path";
import { copyFile, mkdir, rm, chmod, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";

type Target = { appId: string; windowId: string };
type NativeAction = { type: string; [key: string]: unknown };
type Window = Target & { title: string; width: number; height: number };

export type HandoffSelection = { workspace: number; address?: string; stableId?: string };
export type NativeOpen = { workspace: number; applicationId: string; window?: { width: number; height: number } };
export type NativePresentation = { workspace: number; monitor: string };
export function parseNativePresentation(value: unknown): NativePresentation {
  const input = record(value);
  if (Object.keys(input).some(key => !["workspace", "monitor"].includes(key))
      || typeof input.monitor !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.monitor))
    throw new OrbitError("INVALID_REQUEST", "Presentation requires one explicit connected monitor name and numbered workspace");
  const { workspace } = parseHandoff({ workspace: input.workspace });
  return { workspace, monitor: input.monitor };
}
export function parseNativeOpen(value: unknown): NativeOpen {
  const input = record(value);
  parseHandoff({ workspace: input.workspace });
  if (Object.keys(input).some(key => !["workspace", "applicationId", "window"].includes(key))
      || typeof input.applicationId !== "string" || input.applicationId.length > 1024
      || !/^[^/\\\0\r\n]+\.desktop$/.test(input.applicationId))
    throw new OrbitError("INVALID_REQUEST", "Opening requires a registered applicationId and a numbered workspace; arbitrary commands are unavailable");
  const window = input.window === undefined ? undefined : record(input.window);
  if (window && (Object.keys(window).some(key => !["width", "height"].includes(key))
      || typeof window.width !== "number" || !Number.isInteger(window.width) || window.width < 320 || window.width > 3840
      || typeof window.height !== "number" || !Number.isInteger(window.height) || window.height < 240 || window.height > 2160))
    throw new OrbitError("INVALID_REQUEST", "Window size requires width 320 to 3840 and height 240 to 2160");
  return { workspace: Number(input.workspace), applicationId: input.applicationId,
    ...(window ? { window: { width: Number(window.width), height: Number(window.height) } } : {}) };
}
export function parseHandoff(value: unknown): HandoffSelection {
  const input = record(value);
  if (Object.keys(input).some(key => !["workspace", "address", "stableId"].includes(key))
      || typeof input.workspace !== "number" || !Number.isInteger(input.workspace)
      || input.workspace < 1 || input.workspace > 2147483647
      || (input.address === undefined) !== (input.stableId === undefined))
    throw new OrbitError("INVALID_REQUEST", "Handoff requires a workspace and optionally an exact window address with stableId");
  if (input.address !== undefined && (typeof input.address !== "string" || !/^0x[0-9a-f]{1,16}$/.test(input.address)
      || typeof input.stableId !== "string" || !/^[0-9a-f]{1,16}$/.test(input.stableId)))
    throw new OrbitError("INVALID_REQUEST", "Invalid existing window identity");
  return { workspace: input.workspace, ...(input.address === undefined ? {} : { address: String(input.address), stableId: String(input.stableId) }) };
}

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
  readonly visible = true;
  readonly capabilities = ["windows", "cursor", "move", "click", "scroll", "mouse-down", "mouse-up", "drag", "text", "key", "state", "observe", "close-window", "close-application", "pause", "resume", "stop"];
  private applications = new Set<string>();
  private windows = new Map<string, Window>();
  private selected?: Target;
  private size = defaultViewport;
  private pointer: { x: number; y: number } | null = null;
  private scales = new Map<string, { x: number; y: number }>();

  private closing?: Promise<void>;
  handoff?: { workspace: number; appId: string; selectedWindowId: string; scope: string; clipboard: "shared"; windowEnrollment?: "client-windows" | "selected-dialog-family"; pointer: { x: number; y: number }; windows: Window[] };
  private constructor(private worker: NativeWorker, private directory: string, private options: NativeOptions, readonly borrowed = false) {
    if (borrowed) this.capabilities = this.capabilities.filter(value => value !== "launch");
  }

  static async create(_profile: string, options: NativeOptions, handoff?: HandoffSelection) {
    if (handoff === undefined) throw new OrbitError("UNSUPPORTED", "Private native sessions were removed; select an existing application explicitly");
    requireNativeAdapter();
    await requireResourceBudget();
    if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native broker requires Linux");
    // Application bus socket paths must stay below the Unix path limit, independent of project paths.
    const directory = await createWorkspaceDirectory("native", "/var/tmp/orbit-native-" + process.getuid?.());
    let worker: NativeWorker;
    try {
      worker = await NativeWorker.create(join(directory, "worker"), options,
        ["/usr/bin/python3", join(import.meta.dir, "native/existing_worker.py")]);
    }
    catch (error) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Native startup and directory cleanup failed"); }
      throw error;
    }
    const backend = new NativeBackend(worker, directory, options, handoff !== undefined);
    try {
      const response = record(await worker.request("status", {}));
      if (response.ready !== true) throw new OrbitError("BACKEND_ERROR", "Native worker did not become ready");
      if (handoff !== undefined) {
        const claimed = record(await worker.request("claim", handoff));
        const appId = identifier(claimed.appId);
        if (claimed.scope !== "entire-wayland-client" || claimed.clipboard !== "shared" || !Array.isArray(claimed.windows))
          throw new OrbitError("BACKEND_ERROR", "Invalid application handoff acknowledgement");
        if (claimed.windowEnrollment !== undefined && claimed.windowEnrollment !== "client-windows" && claimed.windowEnrollment !== "selected-dialog-family")
          throw new OrbitError("BACKEND_ERROR", "Invalid application window enrollment acknowledgement");
        backend.applications.add(appId);
        const windows = claimed.windows.map(value => {
          const window = record(value), identity = target(window);
          if (identity.appId !== appId || typeof window.title !== "string" || typeof window.width !== "number" || typeof window.height !== "number")
            throw new OrbitError("BACKEND_ERROR", "Invalid handed-off window metadata");
          return { ...identity, title: window.title, width: window.width, height: window.height };
        });
        for (const window of windows) backend.windows.set(window.windowId, window);
        const selectedWindowId = identifier(claimed.selectedWindowId);
        const selectedWindow = backend.windows.get(selectedWindowId);
        if (!selectedWindow) throw new OrbitError("BACKEND_ERROR", "Selected handoff window was not acknowledged");
        const point = record(claimed.pointer);
        if (typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)
            || point.x < 0 || point.y < 0 || point.x >= selectedWindow.width || point.y >= selectedWindow.height)
          throw new OrbitError("BACKEND_ERROR", "Invalid initial native pointer acknowledgement");
        backend.selected = { appId, windowId: selectedWindowId };
        backend.size = { width: selectedWindow.width, height: selectedWindow.height };
        backend.pointer = { x: point.x, y: point.y };
        backend.handoff = { workspace: handoff.workspace, appId, selectedWindowId, scope: "entire-wayland-client", clipboard: "shared", pointer: backend.pointer, windows,
          ...(claimed.windowEnrollment === undefined ? {} : { windowEnrollment: claimed.windowEnrollment }) };
      }
      return backend;
    } catch (error) {
      // Retain the same private diagnostics as a normal close. Deleting a failed
      // claim's journal made its public diagnostic reference impossible to inspect.
      try { await backend.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Native startup and cleanup failed"); }
      throw error;
    }
  }

  static async candidates(options: NativeOptions, selection: HandoffSelection) {
    await requireResourceBudget();
    const directory = await createWorkspaceDirectory("native", "/var/tmp/orbit-native-" + process.getuid?.());
    let worker: NativeWorker | undefined;
    try {
      worker = await NativeWorker.create(join(directory, "worker"), options,
        ["/usr/bin/python3", join(import.meta.dir, "native/existing_worker.py")]);
      return await worker.request("candidates", selection);
    } finally {
      if (worker) await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  private static async presentationRequest(options: NativeOptions, method: "monitors" | "present", params: Record<string, unknown>) {
    requireNativeAdapter();
    let directory: string | undefined;
    let dispatched = false;
    let backend: NativeBackend | undefined;
    let result: unknown;
    try {
      await requireResourceBudget();
      directory = await createWorkspaceDirectory("native", "/var/tmp/orbit-native-" + process.getuid?.());
      const worker = await NativeWorker.create(join(directory, "worker"), options,
        ["/usr/bin/python3", join(import.meta.dir, "native/existing_worker.py")]);
      backend = new NativeBackend(worker, directory, options, true);
      try {
        dispatched = true;
        result = await worker.request(method, params);
      }
      catch (error) {
        if (method === "present" && !(error instanceof OrbitError && ["APPROVAL_REQUIRED", "NATIVE_INCOMPATIBLE", "PRESENTATION_NOT_READY"].includes(error.code)))
          throw new OrbitError("PRESENTATION_UNCONFIRMED", "Workspace presentation was not confirmed and display state may have changed. Inspect monitors and reuse the same requestId; do not replay the mutation blindly.");
        throw error;
      }
    } catch (error) {
      try {
        if (backend) await backend.close();
        else if (directory) await rm(directory, { recursive: true, force: true });
      } catch (cleanup) {
        if (error instanceof Error)
          Object.defineProperty(error, "cause", { value: cleanup, configurable: true });
      }
      if (method === "present" && !dispatched) {
        const failure = new OrbitError("PRESENTATION_NOT_READY", "Presentation did not start. Inspect native readiness and retry the same requestId after resolving the startup failure.");
        Object.defineProperty(failure, "cause", { value: error, configurable: true });
        throw failure;
      }
      throw error;
    }
    try { await backend.close(); }
    catch (error) {
      if (method !== "present") throw error;
      const failure = new OrbitError("PRESENTATION_UNCONFIRMED", "Workspace presentation was not confirmed and display state may have changed. Inspect monitors and reuse the same requestId; do not replay the mutation blindly.");
      Object.defineProperty(failure, "cause", { value: error, configurable: true });
      throw failure;
    }
    return result;
  }

  static async monitors(options: NativeOptions) {
    const result = record(await this.presentationRequest(options, "monitors", {}));
    if (!Array.isArray(result.monitors) || result.monitors.length > 64
        || result.monitors.some(value => {
          const monitor = record(value);
          return typeof monitor.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(monitor.name)
            || typeof monitor.focused !== "boolean" || !(monitor.workspace === null
              || typeof monitor.workspace === "number" && Number.isInteger(monitor.workspace) && monitor.workspace >= 1 && monitor.workspace <= 2147483647);
        }))
      throw new OrbitError("BACKEND_ERROR", "Native worker returned invalid monitor metadata");
    return result;
  }

  static async present(options: NativeOptions, value: NativePresentation) {
    value = parseNativePresentation(value);
    const result = record(await this.presentationRequest(options, "present", value));
    if (result.workspace !== value.workspace || result.monitor !== value.monitor || result.visible !== true
        || result.ownerFocusPreserved !== "during-presentation" || result.sampled !== "compositor-acknowledgement")
      throw new OrbitError("PRESENTATION_UNCONFIRMED", "Presentation acknowledgement was invalid. Inspect monitors before further work; do not replay the mutation blindly.");
    return result;
  }

  static async openApplication(options: NativeOptions, value: NativeOpen) {
    value = parseNativeOpen(value);
    const application = await resolveInstalledApplication(value.applicationId);
    await requireResourceBudget();
    const directory = await createWorkspaceDirectory("native", "/var/tmp/orbit-native-" + process.getuid?.());
    let worker: NativeWorker | undefined;
    let remove = false;
    let result: unknown;
    let primary: unknown;
    const cleanup: unknown[] = [];
    try {
      worker = await NativeWorker.create(join(directory, "worker"), options,
        ["/usr/bin/python3", join(import.meta.dir, "native/existing_worker.py")]);
      result = await worker.request("open", { workspace: value.workspace, argv: application.argv, ...(value.window ? { window: value.window } : {}), ...(application.cwd ? { cwd: application.cwd } : {}), ...(application.busName ? { busName: application.busName } : {}) });
      remove = true;
    } catch (error) {
      // A denied approval did not dispatch. Other errors retain uncertain launch evidence.
      remove = error instanceof OrbitError && error.code === "APPROVAL_REQUIRED";
      primary = error;
    }
    let stopped = !worker;
    if (worker) {
      try { await worker.close(); stopped = true; }
      catch (error) { cleanup.push(error); }
    }
    if (remove && stopped) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) { cleanup.push(error); }
    }
    if (primary !== undefined) {
      if (cleanup.length && primary instanceof Error)
        Object.defineProperty(primary, "cause", { value: new AggregateError(cleanup, "Native opening cleanup failed"), configurable: true });
      throw primary;
    }
    if (cleanup.length) throw new AggregateError(cleanup, "Native opening cleanup failed");
    return result;
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
          if (file === "worker.log" || file === "color-scheme.json" || /^capture-[a-f0-9]{32}\.log$/.test(file))
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
      windows: ["appId"], "close-application": ["appId"],
      cursor: ["appId", "windowId", "x", "y"], move: ["appId", "windowId", "x", "y"],
      click: ["appId", "windowId", "x", "y", "button"], scroll: ["appId", "windowId", "x", "y", "dy"],
      "mouse-down": ["appId", "windowId", "x", "y", "button"], "mouse-up": ["appId", "windowId", "x", "y", "button"],
      drag: ["appId", "windowId", "x", "y", "toX", "toY", "button"],
      text: ["appId", "windowId", "text"], key: ["appId", "windowId", "key"],
      "close-window": ["appId", "windowId"], state: ["appId", "windowId"],
    };
    const allowed = fields[input.type];
    if (!allowed || Object.keys(input).some(key => key !== "type" && !allowed.includes(key)))
      throw new OrbitError("INVALID_REQUEST", "Unknown native action or unexpected fields");
    identifier(input.appId);
    if (allowed.includes("windowId")) target(input);
    // Full shape and coordinate validation runs in the worker before admission or delivery.
    return { ...input, type: input.type };
  }

  async act(value: unknown): Promise<unknown> {
    const action = this.parseAction(value);
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
    if (["cursor", "move", "click", "scroll", "mouse-down", "mouse-up", "drag"].includes(action.type)) {
      const scale = this.scales.get(this.selected.windowId) ?? { x: 1, y: 1 };
      const end = action.type === "drag" ? { x: Number(action.toX), y: Number(action.toY) } : { x: Number(action.x), y: Number(action.y) };
      this.pointer = { x: end.x * scale.x, y: end.y * scale.y };
    }
    return result;
  }

  control(value: unknown) { return this.act(value); }

  async pauseLease() { if (this.borrowed) await this.worker.request("pause", {}); }
  async resumeLease() { if (this.borrowed) await this.worker.request("resume", {}); }

  async presence() {
    const entries = [...this.windows.values()];
    const selected = this.selected && this.windows.get(this.selected.windowId);
    return { title: selected?.title ?? "Native target not selected", location: this.handoff ? `Workspace ${this.handoff.workspace}` : "Orbit native scoped applications",
      pointer: this.pointer, pageCount: entries.length, pageIndex: selected ? entries.indexOf(selected) + 1 : 0,
      tabs: entries.map((window, index) => ({ tab: index + 1, label: window.title, active: window.windowId === this.selected?.windowId,
        appId: window.appId, windowId: window.windowId })), sampled: "acknowledged metadata" };
  }

  /** A digest of the window as it is now, so a later settled capture can tell a stale frame from a new one. */
  async baseline(selected: Target): Promise<string> {
    if (!this.applications.has(selected.appId)) throw new OrbitError("INVALID_REQUEST", "Baseline requires an owned native target");
    const reply = record(await this.worker.request("act", { type: "observe", ...selected, digestOnly: true }));
    if (typeof reply.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(reply.sha256))
      throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid baseline digest");
    return reply.sha256;
  }

  async observe(value?: unknown, format: "image" | "text" | "both" = "image", settle?: { since?: string; timeoutMs: number }) {
    const selected = value === undefined ? this.selected : target(record(value));
    if (!selected || !this.applications.has(selected.appId))
      throw new OrbitError("INVALID_REQUEST", "Observe requires an explicit owned native target");
    const frame = record(await this.worker.request("act", { type: "observe", ...selected, ...(format === "image" ? {} : { format }), ...(settle ?? {}) }));
    // A text frame carries the accessibility tree and no pixels; every other frame is an image.
    const textOnly = frame.mimeType === "text/x-orbit-a11y" && format === "text" && frame.image === undefined;
    if (frame.appId !== selected.appId || frame.windowId !== selected.windowId
        || (!textOnly && (frame.mimeType !== "image/png" || typeof frame.image !== "string"))
        || typeof frame.width !== "number" || typeof frame.height !== "number")
      throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid target frame");
    await this.act({ type: "windows", appId: selected.appId });
    this.selected = selected;
    this.size = { width: frame.width, height: frame.height };
    this.scales.set(selected.windowId, { x: frame.width / Number(frame.surfaceWidth), y: frame.height / Number(frame.surfaceHeight) });
    const point = frame.pointer === null ? null : record(frame.pointer);
    this.pointer = point === null ? null : { x: Number(point.x) * frame.width / Number(frame.surfaceWidth),
      y: Number(point.y) * frame.height / Number(frame.surfaceHeight) };
    return { ...frame, presence: await this.presence() };
  }
}
