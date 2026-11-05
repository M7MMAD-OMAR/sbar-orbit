import { expect, spyOn, test } from "bun:test";
import { NativeBackend, parseHandoff, parseNativeOpen } from "../src/hyprland";
import { NativeWorker, nativeOptionsFromEnv } from "../src/native-worker";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import * as budget from "../src/resource-budget";
import * as storage from "../src/workspace-storage";

const appId = "a".repeat(32), windowId = "b".repeat(32);
const selection = { workspace: 1, address: "0x123", stableId: "c".repeat(32) };
const options = { adapter: "platform" as const, controlDirectory: "/owned/platform-control" };
const window = { appId, windowId, title: "Owned platform fixture", width: 640, height: 480 };
const capabilities = ["windows", "state", "observe", "close-application", "pause", "resume", "stop"];
const status = { ready: true, platform: "darwin", scope: "selected-platform-window", workspaceKind: "current-visible-desktop",
  clipboard: "not-accessed", capabilities, pointerInput: false, keyInput: false, indicator: "not-qualified", nativeAcceptance: "unmeasured" };
const claim = { appId, selectedWindowId: windowId, scope: "selected-platform-window", clipboard: "not-accessed",
  windowEnrollment: "selected-window", pointer: null, windows: [window] };
const routingTest = process.platform === "linux" ? test : test.skip;

async function asMac(operation: () => Promise<void>) {
  const limits = await budget.requireResourceBudget();
  const bounded = spyOn(budget, "requireResourceBudget").mockResolvedValue(limits);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const base = join(homedir(), ".cache");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "orbit-platform-routing-"));
  const previousCache = process.env.XDG_CACHE_HOME;
  const previousSystemRoot = process.env.SystemRoot;
  process.env.XDG_CACHE_HOME = join(root, "cache");
  options.controlDirectory = join(root, "control");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try { await operation(); } finally {
    Object.defineProperty(process, "platform", platform);
    bounded.mockRestore();
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    if (previousSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previousSystemRoot;
    await rm(root, { recursive: true, force: true });
  }
}

async function workerLog(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "worker.log"), "Owned routing fixture\n", { mode: 0o600 });
}

routingTest("platform routing negotiates read-only selected-window control and refuses writes before helper dispatch", async () => asMac(async () => {
  const requests: { method: string; params: unknown }[] = [];
  const create = spyOn(NativeWorker, "create").mockImplementation(async (directory, received, entry) => {
    await workerLog(directory);
    expect(received.adapter).toBe("platform");
    expect(entry?.slice(0, 2)).toEqual(["/usr/bin/python3", "-I"]);
    return { close: async () => {}, request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "status") return status;
      if (method === "claim") return claim;
      if (method === "act") return { appId, windowId, width: 640, height: 480, surfaceWidth: 640, surfaceHeight: 480,
        capturedAt: Date.now(), pointer: null, cursorVariant: 0, windows: [window], mimeType: "text/x-orbit-a11y",
        tree: { status: "ok", nodes: [{ role: "button", name: "Owned" }], complete: true, truncated: null } };
      return { paused: method === "pause" };
    } } as unknown as NativeWorker;
  });
  let backend: NativeBackend | undefined;
  try {
    backend = await NativeBackend.create("unused", options, selection);
    expect(backend.capabilities).toEqual(capabilities);
    expect(backend.handoff).toMatchObject({ scope: "selected-platform-window", windowEnrollment: "selected-window", pointer: null,
      indicator: "not-qualified", nativeAcceptance: "unmeasured", workspaceKind: "current-visible-desktop" });
    const before = requests.length;
    for (const type of ["click", "key", "text", "ref-click", "invoke-ref", "edit-ref", "value-ref", "close-window"])
      await expect(backend.act({ type, appId, windowId })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(requests).toHaveLength(before);
    expect(await backend.observe({ appId, windowId }, "text")).toMatchObject({ pointer: null, tree: { complete: true } });
    await backend.pauseLease();
    expect(requests.at(-1)?.method).toBe("pause");
  } finally { await backend?.close(); create.mockRestore(); }
}));

routingTest("platform routing rejects capability escalation and private desktop claims", async () => asMac(async () => {
  let response: unknown = { ...status, capabilities: [...capabilities, "click"] };
  const create = spyOn(NativeWorker, "create").mockImplementation(async directory => {
    await workerLog(directory);
    return { close: async () => {}, request: async (method: string) => method === "status" ? response : claim } as unknown as NativeWorker;
  });
  try {
    await expect(NativeBackend.create("unused", options, selection)).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    response = { ...status, workspaceKind: "private-desktop" };
    await expect(NativeBackend.create("unused", options, selection)).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    create.mockClear();
    await expect(NativeBackend.create("unused", options, { ...selection, workspace: 2 })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(NativeBackend.present(options, { workspace: 1, monitor: "owned" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(NativeBackend.workspaceInventory(options)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(create).not.toHaveBeenCalled();
  } finally { create.mockRestore(); }
}));

routingTest("an experimental Windows overlay cannot qualify writes or standalone launching", async () => asMac(async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const directory = await mkdtemp(join(options.controlDirectory, "../windows-"));
  const workspace = spyOn(storage, "createWorkspaceDirectory").mockResolvedValue(directory);
  let claimed = false;
  const requests: string[] = [];
  const create = spyOn(NativeWorker, "create").mockImplementation(async worker => {
    await workerLog(worker);
    return { close: async () => {}, request: async (method: string) => {
      requests.push(method);
      if (method === "status") return { ...status, platform: "win32", ...(claimed ? {
        indicator: "selected-window-overlay", capabilities: [...capabilities, "invoke-ref", "edit-ref", "close-window"],
      } : {}) };
      if (method === "claim") { claimed = true; return claim; }
      return {};
    } } as unknown as NativeWorker;
  });
  try {
    // The worker is an owned transport fixture, not a native Windows API qualification.
    process.env.SystemRoot ??= "C:\\Windows";
    await expect(NativeBackend.create("unused", options, selection)).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    expect(requests.slice(0, 3)).toEqual(["status", "claim", "status"]);
    create.mockClear();
    await expect(NativeBackend.openApplication(options, { workspace: 1, applicationId: "notepad.exe" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(create).not.toHaveBeenCalled();
  } finally { create.mockRestore(); workspace.mockRestore(); }
}));

routingTest("platform identity parsing accepts only native registered identities and generation handles", async () => asMac(async () => {
  expect(parseHandoff(selection)).toEqual(selection);
  expect(parseNativeOpen({ workspace: 1, applicationId: "org.example.Owned" })).toEqual({ workspace: 1, applicationId: "org.example.Owned" });
  expect(() => parseHandoff({ ...selection, stableId: "1234" })).toThrow();
  expect(() => parseNativeOpen({ workspace: 1, applicationId: "/Applications/Owned.app" })).toThrow();
  const keys = ["ORBIT_NATIVE_PLAN", "ORBIT_NATIVE_CONTROL", "ORBIT_NATIVE_APPEARANCE", "ORBIT_NATIVE_ADAPTER"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.ORBIT_NATIVE_CONTROL = options.controlDirectory;
    expect(nativeOptionsFromEnv()).toEqual(options);
    process.env.ORBIT_NATIVE_PLAN = "/invented/wayland-plan";
    expect(() => nativeOptionsFromEnv()).toThrow();
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
}));
