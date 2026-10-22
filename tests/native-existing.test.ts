import type { NativeWorker as WorkerType } from "../src/native-worker";
import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { NativeBackend, parseHandoff } from "../src/hyprland";
import { Sessions } from "../src/session";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { OrbitError } from "../src/errors";

test("existing handoff requires a workspace and paired exact window identity", () => {
  expect(parseHandoff({ workspace: 8 })).toEqual({ workspace: 8 });
  expect(() => parseHandoff({ workspace: 8, address: "0x100" })).toThrow();
  expect(() => parseHandoff({ workspace: 0 })).toThrow();
  expect(() => parseHandoff({ workspace: 8, pid: 123 })).toThrow();
});

test("stop wins while a native resume response is pending", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("handoff-resume-stop"), undefined, undefined, { planPath: "/fixture/host.json", controlDirectory: "/fixture/control" });
  const run = (method: string, params: unknown) => sessions.dispatch({ method, params });
  const create = spyOn(NativeBackend, "create").mockResolvedValue(Object.assign(Object.create(NativeBackend.prototype), {
    capabilities: [], onClose: () => {}, close: async () => {},
  }) as NativeBackend);
  let created: { sessionId: string };
  try { created = await run("session.create", { backend: "native", handoff: { workspace: 2 } }) as { sessionId: string }; }
  finally { create.mockRestore(); }
  const session = sessions["get"](created.sessionId);
  const original = session.backend;
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<void>();
  session.backend = Object.assign(Object.create(NativeBackend.prototype) as NativeBackend, {
    close: () => original.close(), pauseLease: async () => {},
    resumeLease: async () => { started.resolve(); await response.promise; },
  });
  try {
    await run("session.pause", created);
    const resume = run("session.resume", created);
    const outcome = resume.then(value => value, error => error);
    await started.promise;
    await run("session.stop", created);
    response.resolve();
    expect(await outcome).toMatchObject({ code: "SESSION_CLOSED" });
    expect(session.state).toBe("closed");
  } finally { response.resolve(); await sessions.close(); }
});

test("failed native pause blocks admission and can be retried", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("handoff-pause-retry"), undefined, undefined, { planPath: "/fixture/host.json", controlDirectory: "/fixture/control" });
  const run = (method: string, params: unknown) => sessions.dispatch({ method, params });
  const create = spyOn(NativeBackend, "create").mockResolvedValue(Object.assign(Object.create(NativeBackend.prototype), {
    capabilities: [], onClose: () => {}, close: async () => {},
  }) as NativeBackend);
  let created: { sessionId: string };
  try { created = await run("session.create", { backend: "native", handoff: { workspace: 2 } }) as { sessionId: string }; }
  finally { create.mockRestore(); }
  const session = sessions["get"](created.sessionId);
  const original = session.backend;
  let attempts = 0;
  session.backend = Object.assign(Object.create(NativeBackend.prototype) as NativeBackend, {
    close: () => original.close(), resumeLease: async () => {},
    pauseLease: async () => { if (++attempts === 1) throw new OrbitError("BACKEND_ERROR", "Pause response lost"); },
  });
  try {
    await expect(run("session.pause", created)).rejects.toThrow("Pause response lost");
    expect(session.state).toBe("pausing");
    await expect(run("session.resume", created)).rejects.toMatchObject({ code: "PAUSED" });
    await expect(run("session.pause", created)).resolves.toMatchObject({ state: "paused" });
    expect(attempts).toBe(2);
  } finally { await sessions.close(); }
});

(process.platform === "linux" ? test : test.skip)("borrowed application cleanup preserves live content and recovers a lost claim reply", async () => {
  const entry = join(import.meta.dir, "native_existing_test.py");
  for (const unfixed of [false, true]) {
    const child = Bun.spawn(["/usr/bin/python3", entry, ...(unfixed ? ["--unfixed-close"] : [])], { stdout: "pipe", stderr: "pipe" });
    const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(out).toBe("");
    if (unfixed) { expect(code).toBe(1); expect(errors).toContain("Native session cleanup failed"); }
    else { expect(code).toBe(0); expect(errors).toContain("OK"); }
  }
});


test("native handoff defaults to full local action classes and validates explicit policy", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("native-policy"), undefined, undefined,
    { planPath: "/fixture/host.json", controlDirectory: "/fixture/control" });
  const create = spyOn(NativeBackend, "create").mockResolvedValue(Object.assign(Object.create(NativeBackend.prototype), {
    capabilities: [], onClose: () => {}, close: async () => {},
  }) as NativeBackend);
  try {
    const result = await sessions.dispatch({ method: "session.create", params: { handoff: { workspace: 2 }, policy: { mode: "autonomous" } } });
    expect(result).toMatchObject({ policy: { mode: "autonomous", origins: "any", allow: ["read", "navigate", "write", "irreversible"], deny: [] } });
    await expect(sessions.dispatch({ method: "session.create", params: { handoff: { workspace: 2 }, policy: { origins: null } } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(create).toHaveBeenCalledTimes(1);
  } finally { create.mockRestore(); await sessions.close(); }
});

test("image observation refreshes acknowledged window titles after an application save", async () => {
  const appId = "a".repeat(32), windowId = "b".repeat(32);
  const backend = Object.assign(Object.create(NativeBackend.prototype), {
    applications: new Set([appId]), windows: new Map([[windowId, { appId, windowId, title: "Draft", width: 640, height: 480 }]]),
    scales: new Map(), worker: { request: async (_method: string, action: { type: string }) => action.type === "observe"
      ? { appId, windowId, mimeType: "image/png", image: "fixture", width: 640, height: 480, surfaceWidth: 640, surfaceHeight: 480, pointer: null }
      : { windows: [{ appId, windowId, title: "saved.txt", width: 640, height: 480 }] } },
  }) as NativeBackend;
  const frame = await backend.observe({ appId, windowId });
  expect(frame.presence.title).toBe("saved.txt");
});

test("a failed native claim retains its private worker journal before workspace cleanup", async () => {
  const { mkdir, writeFile, readdir, readFile, rm } = await import("node:fs/promises");
  const { NativeWorker } = await import("../src/native-worker");
  const root = await createWorkspaceDirectory("failed-claim-diagnostics");
  const failure = new OrbitError("NATIVE_FAILED", "Fixture claim failure");
  let directory = "", closed = 0;
  const create = spyOn(NativeWorker, "create").mockImplementation(async path => {
    directory = path;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(path, "worker.log"), "fixture native claim diagnostic\n", { mode: 0o600 });
    return { request: async (method: string) => { if (method === "status") return { ready: true }; throw failure; },
      close: async () => { closed++; } } as unknown as WorkerType;
  });
  try {
    await expect(NativeBackend.create("fixture", { planPath: "/fixture/host.json", controlDirectory: join(root, "control") },
      { workspace: 2 })).rejects.toBe(failure);
    expect(closed).toBe(1);
    const logs = join(root, "control", "broker-logs"), retained = await readdir(logs);
    expect(retained).toHaveLength(1);
    const name = retained[0];
    if (!name) throw new Error("Expected retained native diagnostics");
    expect(await readFile(join(logs, name, "worker.log"), "utf8")).toBe("fixture native claim diagnostic\n");
  } finally {
    create.mockRestore();
    await rm(root, { recursive: true, force: true });
    if (directory) await rm(join(directory, ".."), { recursive: true, force: true });
  }
});

test("handoff reports the actual selected viewport and its acknowledged default pointer", async () => {
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const { NativeWorker } = await import("../src/native-worker");
  const root = await createWorkspaceDirectory("initial-native-presence");
  const appId = "a".repeat(32), windowId = "b".repeat(32);
  let directory = "", backend: NativeBackend | undefined;
  const create = spyOn(NativeWorker, "create").mockImplementation(async path => {
    directory = path;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(path, "worker.log"), "", { mode: 0o600 });
    return { request: async (method: string) => method === "status" ? { ready: true } : {
      appId, selectedWindowId: windowId, scope: "entire-wayland-client", clipboard: "shared", pointer: { x: 160, y: 90 },
      windows: [{ appId, windowId, width: 320, height: 180, title: "Original fixture application" }],
    }, close: async () => {} } as unknown as WorkerType;
  });
  try {
    backend = await NativeBackend.create("fixture", { planPath: "/fixture/host.json", controlDirectory: join(root, "control") }, { workspace: 2 });
    expect(backend.surface).toEqual({ width: 320, height: 180 });
    expect(await backend.presence()).toMatchObject({ pointer: { x: 160, y: 90 }, pageCount: 1 });
    expect(backend.handoff?.pointer).toEqual({ x: 160, y: 90 });
    expect(backend.handoff?.workspace).toBe(2);
    expect(await backend.presence()).toMatchObject({ location: "Workspace 2" });
  } finally {
    create.mockRestore();
    await backend?.close();
    await rm(root, { recursive: true, force: true });
    if (directory) await rm(join(directory, ".."), { recursive: true, force: true });
  }
});
