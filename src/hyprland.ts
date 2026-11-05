import { OrbitError, record } from "./errors";
import { resolveInstalledApplication } from "./application-launch";
import { platformNativeEntry } from "./platform-native";
import { requireNativeAdapter } from "./native-availability";
import { reapWorkerLease } from "./native-prepare";
import { NativeWorker, type NativeOptions } from "./native-worker";
import { ensureNativeReady } from "./native-readiness";
import { defaultViewport, type Viewport } from "./viewport";
import { createWorkspaceDirectory } from "./workspace-storage";
import { requireResourceBudget } from "./resource-budget";
import { basename, join } from "node:path";
import { copyFile, mkdir, rm, chmod, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";

type Target = { appId: string; windowId: string };
type NativeAction = { type: string; [key: string]: unknown };
export function isSemanticActionType(type: string): boolean { return ["invoke-ref", "edit-ref", "value-ref", "ref-click"].includes(type); }
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
      || !(process.platform === "linux" ? /^[^/\\\0\r\n]+\.desktop$/.test(input.applicationId)
        : process.platform === "win32" ? /^[^/\\:*?"<>|\0\r\n]+\.exe$/i.test(input.applicationId)
          : process.platform === "darwin" && /^[^/\\\0\r\n]+$/.test(input.applicationId)))
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
      || typeof input.stableId !== "string" || !(process.platform === "linux" ? /^[0-9a-f]{1,16}$/ : /^[0-9a-f]{32}$/).test(input.stableId)))
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

function platformAdapter(options: NativeOptions): boolean {
  if (process.platform === "linux") {
    if (options.adapter === "platform") throw new OrbitError("UNSUPPORTED", "Platform-native configuration requires Windows or macOS");
    return false;
  }
  if ((process.platform !== "win32" && process.platform !== "darwin") || options.adapter !== "platform")
    throw new OrbitError("UNSUPPORTED", "This operating system requires explicit platform-native control configuration");
  return true;
}

function workerEntry(options: NativeOptions): string[] {
  return options.adapter === "platform" ? platformNativeEntry() : ["/usr/bin/python3", join(import.meta.dir, "native/existing_worker.py")];
}

function workerDirectory(options: NativeOptions) {
  return options.adapter === "platform" ? createWorkspaceDirectory("native") : createWorkspaceDirectory("native", "/var/tmp/orbit-native-" + process.getuid?.());
}

const platformReadCapabilities = new Set(["windows", "state", "observe", "close-application", "pause", "resume", "stop"]);
function platformAcknowledgement(value: unknown): string[] {
  const response = record(value);
  const capabilities = response.capabilities;
  // A painted experimental overlay does not qualify native HWND lifetime or input.
  const permitted = platformReadCapabilities;
  if (response.ready !== true || response.platform !== process.platform || response.scope !== "selected-platform-window"
      || response.workspaceKind !== "current-visible-desktop" || response.clipboard !== "not-accessed"
      || response.indicator !== "not-qualified" || response.nativeAcceptance !== "unmeasured"
      || response.pointerInput !== false || response.keyInput !== false || !Array.isArray(capabilities)
      || capabilities.length > permitted.size || new Set(capabilities).size !== capabilities.length
      || capabilities.some(item => typeof item !== "string" || !permitted.has(item))
      || !["windows", "state", "observe", "close-application", "pause", "resume", "stop"].every(item => capabilities.includes(item)))
    throw new OrbitError("BACKEND_ERROR", "Platform-native helper did not acknowledge its selected-window scope and activity indication");
  return capabilities;
}

function platformWorkspace(workspace: number) {
  if (workspace !== 1) throw new OrbitError("UNSUPPORTED", "This platform adapter supports explicit selection of the current visible desktop only; numbered workspace placement is unavailable");
}

function platformCandidate(value: unknown) {
  const row = record(value);
  if (typeof row.address !== "string" || !/^0x[0-9a-f]{1,16}$/.test(row.address)
      || typeof row.stableId !== "string" || !/^[0-9a-f]{32}$/.test(row.stableId)
      || typeof row.pid !== "number" || !Number.isSafeInteger(row.pid) || row.pid <= 0
      || typeof row.title !== "string" || row.title.length > 512 || row.workspace !== 1
      || row.windowProtocol !== (process.platform === "win32" ? "win32" : "cocoa")
      || typeof row.width !== "number" || typeof row.height !== "number" || !Number.isFinite(row.width) || !Number.isFinite(row.height)
      || row.width <= 0 || row.height <= 0 || row.width > 8192 || row.height > 8192)
    throw new OrbitError("BACKEND_ERROR", "Platform-native helper returned invalid selected-window metadata");
  return { address: row.address, stableId: row.stableId, pid: row.pid, title: row.title,
    width: row.width, height: row.height, workspace: 1, windowProtocol: row.windowProtocol };
}

function platformCandidates(value: unknown) {
  const result = record(value);
  if (result.workspace !== 1 || result.workspaceKind !== "current-visible-desktop" || !Array.isArray(result.candidates) || result.candidates.length > 256)
    throw new OrbitError("BACKEND_ERROR", "Platform-native helper returned invalid candidate scope");
  return { workspace: 1, workspaceKind: "current-visible-desktop", candidates: result.candidates.map(platformCandidate) };
}

/**
 * A failed cleanup must not replace the reason the work failed. Wrapping a classified refusal in an
 * AggregateError made it a non-Orbit error, which the diagnostics layer reports as the unattributable
 * "Request failed" (measured 30 October 2026: a stale native plan, whose exact repair command the
 * worker had printed, reached the agent as nothing but that). The refusal keeps its code and message,
 * and the cleanup failure rides along as its cause.
 */
export function withCleanup(primary: unknown, cleanup: unknown[], message: string): unknown {
  if (!cleanup.length) return primary;
  if (primary instanceof OrbitError) {
    Object.defineProperty(primary, "cause", { value: new AggregateError(cleanup, message), configurable: true });
    return primary;
  }
  return new AggregateError([primary, ...cleanup], message);
}

/** The compositor is fixed at broker startup. All application targets are worker-owned handles. */
export class NativeBackend {
  readonly visible = true;
  readonly capabilities = ["windows", "cursor", "move", "click", "ref-click", "invoke-ref", "edit-ref", "value-ref", "scroll", "mouse-down", "mouse-up", "drag", "text", "key", "state", "observe", "close-window", "close-application", "pause", "resume", "stop"];
  private platformCapabilities?: ReadonlySet<string>;
  private applications = new Set<string>();
  private windows = new Map<string, Window>();
  private selected?: Target;
  private size = defaultViewport;
  private pointer: { x: number; y: number } | null = null;
  private scales = new Map<string, { x: number; y: number }>();
  private semanticEpoch = 0;
  private semanticPrepared = new Map<object, { token: string; fingerprint: string; epoch: number; sending?: Promise<unknown> }>();

  private closing?: Promise<void>;
  handoff?: { workspace: number; appId: string; selectedWindowId: string; scope: string; clipboard: "shared" | "not-accessed"; windowEnrollment?: "client-windows" | "selected-dialog-family" | "selected-window"; pointer: { x: number; y: number } | null; windows: Window[]; indicator?: "not-qualified" | "selected-window-overlay"; nativeAcceptance?: "unmeasured"; workspaceKind?: "current-visible-desktop" };
  private constructor(private worker: NativeWorker, private directory: string, private options: NativeOptions, readonly borrowed = false) {
    if (borrowed) this.capabilities = this.capabilities.filter(value => value !== "launch");
  }

  private acknowledgePlatform(value: unknown) {
    const capabilities = platformAcknowledgement(value);
    this.platformCapabilities = new Set(capabilities);
    this.capabilities.splice(0, this.capabilities.length, ...capabilities);
  }

  assertActionCapability(type: string) {
    if (this.options?.adapter === "platform" && !this.platformCapabilities?.has(type))
      throw new OrbitError("UNSUPPORTED", "This platform-native adapter has not qualified the requested action; no input was dispatched");
  }

  static async create(_profile: string, options: NativeOptions, handoff?: HandoffSelection) {
    if (handoff === undefined) throw new OrbitError("UNSUPPORTED", "Private native sessions were removed; select an existing application explicitly");
    const platform = platformAdapter(options);
    if (platform) platformWorkspace(handoff.workspace); else requireNativeAdapter();
    await requireResourceBudget();
    await ensureNativeReady(options);
    // Application bus socket paths must stay below the Unix path limit, independent of project paths.
    const directory = await workerDirectory(options);
    let worker: NativeWorker;
    try {
      worker = await NativeWorker.create(join(directory, "worker"), options, workerEntry(options));
    }
    catch (error) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cleanup) { throw withCleanup(error, [cleanup], "Native startup and directory cleanup failed"); }
      throw error;
    }
    const backend = new NativeBackend(worker, directory, options, handoff !== undefined);
    try {
      const response = record(await worker.request("status", {}));
      if (response.ready !== true) throw new OrbitError("BACKEND_ERROR", "Native worker did not become ready");
      if (platform) backend.acknowledgePlatform(response);
      if (handoff !== undefined) {
        const claimed = record(await worker.request("claim", handoff));
        const appId = identifier(claimed.appId);
        if (claimed.scope !== (platform ? "selected-platform-window" : "entire-wayland-client")
            || claimed.clipboard !== (platform ? "not-accessed" : "shared") || !Array.isArray(claimed.windows))
          throw new OrbitError("BACKEND_ERROR", "Invalid application handoff acknowledgement");
        const enrollment = claimed.windowEnrollment;
        if (enrollment !== undefined && enrollment !== "client-windows" && enrollment !== "selected-dialog-family" && enrollment !== "selected-window")
          throw new OrbitError("BACKEND_ERROR", "Invalid application window enrollment acknowledgement");
        if (platform ? enrollment !== "selected-window" : enrollment === "selected-window")
          throw new OrbitError("BACKEND_ERROR", "Invalid application window enrollment acknowledgement");
        backend.applications.add(appId);
        const windows = backend.readWindows(claimed.windows, appId);
        if (platform && windows.length !== 1) throw new OrbitError("BACKEND_ERROR", "Platform-native handoff must acknowledge exactly the selected window");
        for (const window of windows) backend.windows.set(window.windowId, window);
        const selectedWindowId = identifier(claimed.selectedWindowId);
        const selectedWindow = backend.windows.get(selectedWindowId);
        if (!selectedWindow) throw new OrbitError("BACKEND_ERROR", "Selected handoff window was not acknowledged");
        const point = platform ? null : record(claimed.pointer);
        if (platform ? claimed.pointer !== null : !point || typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)
            || point.x < 0 || point.y < 0 || point.x >= selectedWindow.width || point.y >= selectedWindow.height)
          throw new OrbitError("BACKEND_ERROR", "Invalid initial native pointer acknowledgement");
        backend.selected = { appId, windowId: selectedWindowId };
        backend.size = { width: selectedWindow.width, height: selectedWindow.height };
        backend.pointer = point ? { x: Number(point.x), y: Number(point.y) } : null;
        let indicator: "not-qualified" | "selected-window-overlay" = "not-qualified";
        if (platform) {
          const current = record(await worker.request("status", {}));
          backend.acknowledgePlatform(current);
          if (current.indicator === "selected-window-overlay") indicator = "selected-window-overlay";
        }
        backend.handoff = { workspace: handoff.workspace, appId, selectedWindowId, scope: platform ? "selected-platform-window" : "entire-wayland-client", clipboard: platform ? "not-accessed" : "shared", pointer: backend.pointer, windows,
          ...(platform ? { indicator, nativeAcceptance: "unmeasured", workspaceKind: "current-visible-desktop" } : {}),
          ...(enrollment === undefined ? {} : { windowEnrollment: enrollment }) };
      }
      return backend;
    } catch (error) {
      // Retain the same private diagnostics as a normal close. Deleting a failed
      // claim's journal made its public diagnostic reference impossible to inspect.
      try { await backend.close(); }
      catch (cleanup) { throw withCleanup(error, [cleanup], "Native startup and cleanup failed"); }
      throw error;
    }
  }

  static async candidates(options: NativeOptions, selection: HandoffSelection) {
    const platform = platformAdapter(options);
    selection = parseHandoff(selection);
    if (platform) platformWorkspace(selection.workspace);
    await requireResourceBudget();
    await ensureNativeReady(options);
    const directory = await workerDirectory(options);
    let worker: NativeWorker | undefined;
    let result: unknown;
    let primary: unknown;
    let failed = false;
    try {
      worker = await NativeWorker.create(join(directory, "worker"), options, workerEntry(options));
      if (platform) platformAcknowledgement(await worker.request("status", {}));
      result = await worker.request("candidates", selection);
      if (platform) result = platformCandidates(result);
    } catch (error) { failed = true; primary = error; }
    const cleanup: unknown[] = [];
    if (worker) { try { await worker.close(); } catch (error) { cleanup.push(error); } }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
    if (failed) throw withCleanup(primary, cleanup, "Native candidates cleanup failed");
    if (cleanup.length) throw new AggregateError(cleanup, "Native candidates cleanup failed");
    return result;
  }

  private static async presentationRequest(options: NativeOptions, method: "monitors" | "workspace_inventory" | "present", params: Record<string, unknown>) {
    const platform = platformAdapter(options);
    if (platform && method !== "monitors") throw new OrbitError("UNSUPPORTED", "This platform has no qualified numbered workspace presentation or occupancy adapter");
    if (!platform) requireNativeAdapter();
    let directory: string | undefined;
    let dispatched = false;
    let backend: NativeBackend | undefined;
    let result: unknown;
    try {
      await requireResourceBudget();
      await ensureNativeReady(options, { requirePlugin: method === "present" });
      directory = await workerDirectory(options);
      const worker = await NativeWorker.create(join(directory, "worker"), options, workerEntry(options));
      backend = new NativeBackend(worker, directory, options, true);
      if (platform) backend.acknowledgePlatform(await worker.request("status", {}));
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
        const reason = error instanceof OrbitError && ["NATIVE_STALE", "NATIVE_INCOMPATIBLE"].includes(error.code) ? " " + error.message : "";
        const failure = new OrbitError("PRESENTATION_NOT_READY", "Presentation did not start. Inspect native readiness and retry the same requestId after resolving the startup failure." + reason);
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

  /** Private numeric occupancy only, never titles or a workspace-switch operation. */
  static async workspaceInventory(options: NativeOptions): Promise<{ occupied: number[]; shown: number[] }> {
    if (platformAdapter(options)) throw new OrbitError("UNSUPPORTED", "Automatic numbered workspace allocation is unavailable on this platform; only explicit current-visible-desktop selection is implemented");
    const result = record(await this.presentationRequest(options, "workspace_inventory", {}));
    const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 16384
      && value.every(item => typeof item === "number" && Number.isInteger(item) && item >= 1 && item <= 2147483647);
    if (!numbers(result.occupied) || !numbers(result.shown) || result.shown.length < 1 || result.shown.length > 64)
      throw new OrbitError("BACKEND_ERROR", "Cannot determine empty numbered workspaces");
    return { occupied: [...result.occupied], shown: [...result.shown] };
  }

  static async monitors(options: NativeOptions) {
    const platform = platformAdapter(options);
    const result = record(await this.presentationRequest(options, "monitors", {}));
    if (!Array.isArray(result.monitors) || result.monitors.length > 64
        || result.monitors.some(value => {
          const monitor = record(value);
          return typeof monitor.name !== "string" || !(platform ? /^[^\0\r\n]{1,128}$/ : /^[A-Za-z0-9_.:-]{1,128}$/).test(monitor.name)
            || typeof monitor.focused !== "boolean" || !(monitor.workspace === null
              || typeof monitor.workspace === "number" && Number.isInteger(monitor.workspace) && monitor.workspace >= 1 && monitor.workspace <= 2147483647);
        }))
      throw new OrbitError("BACKEND_ERROR", "Native worker returned invalid monitor metadata");
    return result;
  }

  static async present(options: NativeOptions, value: NativePresentation) {
    if (platformAdapter(options)) throw new OrbitError("UNSUPPORTED", "Native platform workspace presentation is not qualified; no display change was dispatched");
    value = parseNativePresentation(value);
    const result = record(await this.presentationRequest(options, "present", value));
    if (result.workspace !== value.workspace || result.monitor !== value.monitor || result.visible !== true
        || result.ownerFocusPreserved !== "during-presentation" || result.sampled !== "compositor-acknowledgement")
      throw new OrbitError("PRESENTATION_UNCONFIRMED", "Presentation acknowledgement was invalid. Inspect monitors before further work; do not replay the mutation blindly.");
    return result;
  }

  static async openApplication(options: NativeOptions, value: NativeOpen) {
    value = parseNativeOpen(value);
    if (platformAdapter(options)) throw new OrbitError("UNSUPPORTED", "Platform-native opening has not passed original-application acceptance; no application was launched");
    const request: Record<string, unknown> = { workspace: value.workspace, ...(value.window ? { window: value.window } : {}) };
    const application = await resolveInstalledApplication(value.applicationId);
    Object.assign(request, { requireEmpty: true, argv: application.argv, ...(application.cwd ? { cwd: application.cwd } : {}), ...(application.busName ? { busName: application.busName } : {}) });
    await requireResourceBudget();
    await ensureNativeReady(options);
    const directory = await workerDirectory(options);
    let worker: NativeWorker | undefined;
    let remove = false;
    let result: unknown;
    let primary: unknown;
    const cleanup: unknown[] = [];
    try {
      worker = await NativeWorker.create(join(directory, "worker"), options, workerEntry(options));
      result = await worker.request("open", request);
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
      await this.cancelPreparedActions();
      // Failed worker cleanup retains its private workspace for diagnosis.
      let workerFailure: unknown;
      try { await this.worker.close(); } catch (error) { workerFailure = error; }
      // However the worker ended, its lease must not outlive it.
      if (this.borrowed && this.options.adapter !== "platform") {
        try { await reapWorkerLease(join(this.directory, "worker"), this.options.planPath, this.options.controlDirectory); }
        catch { /* the compositor reaps leases whose worker is gone */ }
      }
      if (workerFailure !== undefined) throw workerFailure;
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
      "ref-click": ["appId", "windowId", "ref", "button"],
      "invoke-ref": ["appId", "windowId", "ref", "index"],
      "edit-ref": ["appId", "windowId", "ref", "text"],
      "value-ref": ["appId", "windowId", "ref", "value"],
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
    this.assertActionCapability(input.type);
    const result: NativeAction = { ...input, type: input.type };
    if (isSemanticActionType(input.type)) {
      if (typeof input.ref !== "string" || !/^@[0-9a-f]{32}:e[0-9]{1,3}$/.test(input.ref))
        throw new OrbitError("INVALID_REF", "Use a complete snapshot ref from this exact window");
      if (input.type === "invoke-ref") {
        result.index ??= 0;
        if (typeof result.index !== "number" || !Number.isInteger(result.index) || result.index < 0 || result.index > 31)
          throw new OrbitError("INVALID_REQUEST", "Semantic action index must be an integer from 0 to 31");
      }
      if (input.type === "edit-ref" && (typeof input.text !== "string" || input.text.includes("\0")
          || Buffer.byteLength(input.text, "utf8") > 16000 || Buffer.from(input.text, "utf8").toString("utf8") !== input.text))
        throw new OrbitError("INVALID_REQUEST", "Semantic text requires 0 to 16000 UTF-8 bytes without NUL");
      if (input.type === "value-ref" && (typeof input.value !== "number" || !Number.isFinite(input.value)))
        throw new OrbitError("INVALID_REQUEST", "Semantic value must be finite");
    }
    // Full shape and coordinate validation runs in the worker before admission or delivery.
    return result;
  }

  async prepareAction(value: unknown): Promise<void> {
    const action = this.parseAction(value);
    if (!isSemanticActionType(action.type)) return;
    if (!value || typeof value !== "object" || this.closing || !this.applications.has(identifier(action.appId)))
      throw new OrbitError("SESSION_CLOSED", "Semantic application control is unavailable");
    const epoch = this.semanticEpoch;
    const reply = record(await this.worker.request("semantic-prepare", { action }));
    if (Object.keys(reply).length !== 1 || typeof reply.token !== "string" || !/^[0-9a-f]{32}$/.test(reply.token))
      throw new OrbitError("BACKEND_ERROR", "Native semantic preparation returned invalid metadata");
    const token = reply.token;
    if (this.closing || this.semanticEpoch !== epoch || this.semanticPrepared.size >= 8) {
      await this.worker.request("semantic-cancel", { token }).catch(() => {});
      throw new OrbitError("PAUSED", "Semantic preparation was revoked before dispatch");
    }
    this.semanticPrepared.set(value, { token, fingerprint: JSON.stringify(action), epoch });
  }

  async cancelPreparedAction(value: object): Promise<void> {
    const prepared = this.semanticPrepared.get(value);
    if (!prepared) return;
    if (!prepared.sending) this.semanticPrepared.delete(value);
    await Promise.allSettled([
      this.worker.request("semantic-cancel", { token: prepared.token }),
      ...(prepared.sending === undefined ? [] : [prepared.sending]),
    ]);
  }

  async cancelPreparedActions(): Promise<void> {
    this.semanticEpoch++;
    const prepared = [...this.semanticPrepared.values()];
    for (const [value, item] of this.semanticPrepared) if (!item.sending) this.semanticPrepared.delete(value);
    // An admitted SEND can still be resolving its native target. Revocation
    // must drain it before acknowledging a narrower policy or ended control.
    await Promise.allSettled(prepared.flatMap(item => [
      this.worker.request("semantic-cancel", { token: item.token }),
      ...(item.sending === undefined ? [] : [item.sending]),
    ]));
  }

  /** Validate the full scoped acknowledgement before changing any cached metadata. */
  private readWindows(value: unknown, appId: string): Window[] {
    const invalid = () => new OrbitError("BACKEND_ERROR", "Native worker returned invalid scoped window metadata");
    if (!Array.isArray(value) || value.length > 4096) throw invalid();
    const seen = new Set<string>();
    const windows = Array.from(value, entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
      const window = entry as Record<string, unknown>;
      if (window.appId !== appId || typeof window.windowId !== "string" || !/^[a-f0-9]{32}$/.test(window.windowId)
          || typeof window.title !== "string" || typeof window.width !== "number" || typeof window.height !== "number"
          || !Number.isFinite(window.width) || !Number.isFinite(window.height) || window.width <= 0 || window.height <= 0
          || seen.has(window.windowId) || (this.windows.has(window.windowId) && this.windows.get(window.windowId)!.appId !== appId))
        throw invalid();
      seen.add(window.windowId);
      return { appId, windowId: window.windowId, title: window.title, width: window.width, height: window.height };
    });
    if (this.options?.adapter === "platform" && (windows.length !== 1
        || this.selected !== undefined && windows[0]?.windowId !== this.selected.windowId)) throw invalid();
    return windows;
  }

  private acknowledgeWindows(owned: Window[], appId: string) {
    const retained = new Set(owned.map(window => window.windowId));
    for (const [key, window] of this.windows) if (window.appId === appId) {
      this.windows.delete(key);
      if (!retained.has(key)) this.scales.delete(key);
    }
    for (const window of owned) this.windows.set(window.windowId, window);
  }

  async act(value: unknown): Promise<unknown> {
    const action = this.parseAction(value);
    const appId = identifier(action.appId);
    if (!this.applications.has(appId)) throw new OrbitError("INVALID_REQUEST", "Native application belongs to another session or is closed");
    if (isSemanticActionType(action.type)) {
      const prepared = value && typeof value === "object" ? this.semanticPrepared.get(value) : undefined;
      if (!prepared || prepared.sending || prepared.epoch !== this.semanticEpoch || prepared.fingerprint !== JSON.stringify(action) || this.closing)
        throw new OrbitError("SEMANTIC_PREPARATION_REQUIRED", "Observe the current target before choosing another semantic action");
      prepared.sending = this.worker.request("semantic-send", { token: prepared.token, action });
      try { return await prepared.sending; }
      finally {
        if (value && typeof value === "object" && this.semanticPrepared.get(value) === prepared)
          this.semanticPrepared.delete(value);
      }
    }
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
      this.acknowledgeWindows(this.readWindows(reply.windows, appId), appId);
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

  async pauseLease() { await this.cancelPreparedActions(); if (this.borrowed) await this.worker.request("pause", {}); }
  async resumeLease() { if (this.borrowed) await this.worker.request("resume", {}); }

  /** Explicit owner selection, not an agent input or observation operation. */
  async reveal() {
    const selected = this.selected;
    if (!this.borrowed || !selected) throw new OrbitError("SESSION_CLOSED", "No retained native session window is available");
    return this.worker.request("reveal", { appId: selected.appId, windowId: selected.windowId });
  }

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

  async observe(value?: unknown, format: "image" | "text" | "both" = "image", settle?: { since?: string; timeoutMs: number; quietMs?: number }) {
    return this.readObservation(value, format, settle);
  }

  /** Internal, explicitly targeted observation. No cursor refresh or input-state commit.
   * This is not an authority grant, a quiescence receipt or live adapter qualification. */
  async observePassive(value: unknown, format: "image" | "text" | "both" = "image", timeoutMs = 1500) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000 || !["image", "text", "both"].includes(format))
      throw new OrbitError("INVALID_REQUEST", "Passive observation requires a known format and an integer budget from 100 to 3000");
    const selected = target(record(value));
    return this.readObservation(selected, format, undefined, timeoutMs);
  }

  private async readObservation(value: unknown, format: "image" | "text" | "both", settle?: { since?: string; timeoutMs: number; quietMs?: number }, passiveTimeoutMs?: number) {
    const passive = passiveTimeoutMs !== undefined;
    const input = value === undefined ? undefined : record(value);
    const selected = input === undefined ? this.selected : target(input);
    const selectors = input === undefined ? {} : Object.fromEntries(["refs", "skeleton", "root"].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
    if (passive && Object.keys(selectors).length) throw new OrbitError("INVALID_REQUEST", "Passive observation cannot retain snapshot refs");
    for (const key of ["refs", "skeleton"]) if (Object.hasOwn(selectors, key) && typeof selectors[key] !== "boolean")
      throw new OrbitError("INVALID_REQUEST", "Observation refs and skeleton must be boolean");
    if (Object.hasOwn(selectors, "root") && (typeof selectors.root !== "string" || !/^@[0-9a-f]{32}:e[0-9]{1,3}$/.test(selectors.root)))
      throw new OrbitError("INVALID_REQUEST", "Root requires a snapshot-scoped ref");
    if (format === "image" && Object.values(selectors).some(Boolean)) throw new OrbitError("INVALID_REQUEST", "Snapshot selectors require text or both");
    if (!selected || !this.applications.has(selected.appId))
      throw new OrbitError("INVALID_REQUEST", "Observe requires an explicit owned native target");
    if (format === "text" && settle && (settle.since !== undefined || settle.quietMs !== undefined))
      throw new OrbitError("INVALID_REQUEST", "Text capture does not accept pixel-settle options");
    const observationOptions = passive ? { observationMode: "passive-v1", observationTimeoutMs: passiveTimeoutMs }
      : format === "text" && settle ? { observationTimeoutMs: settle.timeoutMs } : settle;
    const frame = record(await this.worker.request("act", { type: "observe", ...selected, ...selectors, ...(format === "image" ? {} : { format }), ...(observationOptions ?? {}) }));
    if (passive) {
      const acknowledgement = frame.observation;
      if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
          || record(acknowledgement).mode !== "passive-v1" || record(acknowledgement).cursorRefresh !== "omitted"
          || !Object.hasOwn(frame, "windows"))
        throw new OrbitError("UNSUPPORTED", "Native worker did not acknowledge passive observation; no legacy fallback is permitted");
      if (format === "text" && (frame.mimeType !== "text/x-orbit-a11y" || frame.image !== undefined))
        throw new OrbitError("BACKEND_ERROR", "Passive text observation cannot fall back to image");
    }
    // A text frame carries the accessibility tree and no pixels; every other frame is an image.
    const textOnly = frame.mimeType === "text/x-orbit-a11y" && format === "text" && frame.image === undefined;
    if (frame.appId !== selected.appId || frame.windowId !== selected.windowId
        || (!textOnly && (frame.mimeType !== "image/png" || typeof frame.image !== "string"))
        || typeof frame.width !== "number" || typeof frame.height !== "number"
        || typeof frame.surfaceWidth !== "number" || typeof frame.surfaceHeight !== "number"
        || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0
        || !Number.isFinite(frame.surfaceWidth) || !Number.isFinite(frame.surfaceHeight) || frame.surfaceWidth <= 0 || frame.surfaceHeight <= 0)
      throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid target frame");
    const scale = { x: frame.width / frame.surfaceWidth, y: frame.height / frame.surfaceHeight };
    if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y) || scale.x <= 0 || scale.y <= 0)
      throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid target scale");
    let pointer: { x: number; y: number } | null = null;
    if (frame.pointer !== null) {
      const point = frame.pointer;
      if (!point || typeof point !== "object" || Array.isArray(point))
        throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid target pointer");
      const { x, y } = point as Record<string, unknown>;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)
          || x < 0 || y < 0 || x >= frame.surfaceWidth || y >= frame.surfaceHeight)
        throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid target pointer");
      pointer = { x: x * scale.x, y: y * scale.y };
      if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y))
        throw new OrbitError("BACKEND_ERROR", "Native worker returned an invalid scaled pointer");
    }
    let owned: Window[];
    if (Object.hasOwn(frame, "windows")) {
      owned = this.readWindows(frame.windows, selected.appId);
    } else {
      // Stage the legacy acknowledgement too: a missing captured target must not commit stale state.
      if (!this.applications.has(selected.appId))
        throw new OrbitError("INVALID_REQUEST", "Observed native application is closed");
      const reply = record(await this.worker.request("act", { type: "windows", appId: selected.appId }));
      owned = this.readWindows(reply.windows, selected.appId);
    }
    if (!this.applications.has(selected.appId))
      throw new OrbitError("INVALID_REQUEST", "Observed native application is closed");
    if (!owned.some(window => window.windowId === selected.windowId))
      throw new OrbitError("BACKEND_ERROR", "Observed target was not acknowledged in native window metadata");
    if (passive) {
      // Never overwrite a writer's selected target, pointer or coordinate scale.
      // Do not export sibling-window metadata outside this observed target.
      const observed = owned.find(window => window.windowId === selected.windowId)!;
      const { windows: _windows, ...publicFrame } = frame;
      return { ...publicFrame, presence: { title: observed.title,
        location: this.handoff ? `Workspace ${this.handoff.workspace}` : "Orbit native scoped application",
        pointer, pageCount: 1, pageIndex: 1,
        tabs: [{ tab: 1, label: observed.title, active: true, ...selected }], sampled: "capture-target metadata" } };
    }
    this.acknowledgeWindows(owned, selected.appId);
    this.selected = selected;
    this.size = { width: frame.width, height: frame.height };
    this.scales.set(selected.windowId, scale);
    this.pointer = pointer;
    // Window metadata is already represented in presence; never duplicate the internal acknowledgement.
    const { windows: _windows, ...publicFrame } = frame;
    return { ...publicFrame, presence: await this.presence() };
  }
}
