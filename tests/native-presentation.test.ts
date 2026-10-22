import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NativeBackend, parseNativePresentation } from "../src/hyprland";
import { NativeWorker } from "../src/native-worker";
import { Sessions } from "../src/session";
import { OrbitError } from "../src/errors";
import * as admission from "../src/update-admission";

const params = { requestId: "present-1", workspace: 2, monitor: "HDMI-A-5" };
const acknowledgement = { workspace: 2, monitor: "HDMI-A-5", visible: true,
  ownerFocusPreserved: "during-presentation", sampled: "compositor-acknowledgement" };

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-present-test-"));
  const sessions = new Sessions(root, undefined, undefined,
    { planPath: "/fixture/host.json", controlDirectory: join(root, "control") }, join(root, "update"));
  return { sessions, root, close: async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); } };
};

test("native presentation requires an explicit bounded monitor and numbered workspace", () => {
  expect(parseNativePresentation({ workspace: 2, monitor: "HDMI-A-5" })).toEqual({ workspace: 2, monitor: "HDMI-A-5" });
  for (const value of [{ workspace: 2 }, { workspace: true, monitor: "HDMI-A-5" },
    { workspace: 0, monitor: "HDMI-A-5" }, { workspace: 2147483648, monitor: "HDMI-A-5" },
    { workspace: 2, monitor: "auto".repeat(50) }, { workspace: 2, monitor: "HDMI-A-5;focus" },
    { workspace: 2, monitor: "HDMI-A-5", focus: true }])
    expect(() => parseNativePresentation(value)).toThrow();
});

test("presentation requests reject invalid input before starting a worker", async () => {
  const state = await fixture();
  const present = spyOn(NativeBackend, "present").mockResolvedValue(acknowledgement);
  const monitors = spyOn(NativeBackend, "monitors").mockResolvedValue({ monitors: [] });
  try {
    for (const invalid of [{ ...params, monitor: "HDMI-A-5\nfocus" }, { ...params, extra: true },
      { ...params, requestId: "x".repeat(129) }, { ...params, workspace: -2 }])
      await expect(state.sessions.dispatch({ method: "native.present", params: invalid })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(state.sessions.dispatch({ method: "native.monitors", params: { titles: true } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(present).not.toHaveBeenCalled();
    expect(monitors).not.toHaveBeenCalled();
  } finally { present.mockRestore(); monitors.mockRestore(); await state.close(); }
});

test("presentation delivery is deduplicated and conflicts never mutate", async () => {
  const state = await fixture();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const present = spyOn(NativeBackend, "present").mockImplementation(async () => {
    started.resolve(); await release.promise; return acknowledgement;
  });
  const request = { method: "native.present", params };
  try {
    const first = state.sessions.dispatch(request);
    await started.promise;
    const second = state.sessions.dispatch(request);
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 3 } }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    release.resolve();
    expect(await first).toEqual(acknowledgement);
    expect(await second).toEqual(acknowledgement);
    expect(await state.sessions.dispatch(request)).toEqual(acknowledgement);
    expect(present).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); present.mockRestore(); await state.close(); }
});

test("uncertain presentation results remain cached but owner approval denial can be retried", async () => {
  const state = await fixture();
  const present = spyOn(NativeBackend, "present");
  const request = { method: "native.present", params };
  try {
    present.mockRejectedValueOnce(new OrbitError("APPROVAL_REQUIRED", "Owner control is protected"));
    await expect(state.sessions.dispatch(request)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    present.mockRejectedValue(new OrbitError("PRESENTATION_UNCONFIRMED", "Inspect monitors"));
    await expect(state.sessions.dispatch(request)).rejects.toMatchObject({ code: "PRESENTATION_UNCONFIRMED" });
    await expect(state.sessions.dispatch(request)).rejects.toMatchObject({ code: "PRESENTATION_UNCONFIRMED" });
    expect(present).toHaveBeenCalledTimes(2);
  } finally { present.mockRestore(); await state.close(); }
});

test("a pre-mutation plugin mismatch allows the same presentation identity after rebuild", async () => {
  const state = await fixture();
  const present = spyOn(NativeBackend, "present")
    .mockRejectedValueOnce(new OrbitError("NATIVE_INCOMPATIBLE", "Rebuild and reload the matching plugin"))
    .mockResolvedValue(acknowledgement);
  const request = { method: "native.present", params };
  try {
    await expect(state.sessions.dispatch(request)).rejects.toMatchObject({ code: "NATIVE_INCOMPATIBLE" });
    await expect(state.sessions.dispatch(request)).resolves.toEqual(acknowledgement);
    expect(await state.sessions.dispatch(request)).toEqual(acknowledgement);
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 3 } }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(present).toHaveBeenCalledTimes(2);
  } finally { present.mockRestore(); await state.close(); }
});

(process.platform === "linux" ? test : test.skip)("typed readiness survives the real backend and permits only the same presentation payload to retry", async () => {
  const state = await fixture();
  let calls = 0;
  const create = spyOn(NativeWorker, "create").mockImplementation(async directory => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "worker.log"), "readiness fixture diagnostic\n", { mode: 0o600 });
    return { request: async () => {
      calls++;
      if (calls === 1) throw new OrbitError("PRESENTATION_NOT_READY", "Compositor rejected before mutation");
      return acknowledgement;
    }, close: async () => {} } as unknown as NativeWorker;
  });
  const request = { method: "native.present", params };
  try {
    await expect(state.sessions.dispatch(request)).rejects.toMatchObject({ code: "PRESENTATION_NOT_READY" });
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 3 } }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(calls).toBe(1);
    await expect(state.sessions.dispatch(request)).resolves.toEqual(acknowledgement);
    await expect(state.sessions.dispatch(request)).resolves.toEqual(acknowledgement);
    expect(calls).toBe(2);
  } finally { create.mockRestore(); await state.close(); }
});

test("queued pre-dispatch admission refusal retains identity while allowing a later retry", async () => {
  const state = await fixture();
  const refused = new OrbitError("PROFILE_BUSY", "Update began while queued; retry shortly");
  const gate = spyOn(admission, "requireUpdateAdmission")
    .mockResolvedValueOnce(undefined).mockRejectedValueOnce(refused).mockResolvedValue(undefined);
  const present = spyOn(NativeBackend, "present").mockResolvedValue(acknowledgement);
  const request = { method: "native.present", params };
  try {
    await expect(state.sessions.dispatch(request)).rejects.toMatchObject({ code: "PROFILE_BUSY", message: refused.message });
    expect(present).not.toHaveBeenCalled();
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 3 } }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(state.sessions.dispatch(request)).resolves.toEqual(acknowledgement);
    await expect(state.sessions.dispatch(request)).resolves.toEqual(acknowledgement);
    expect(present).toHaveBeenCalledTimes(1);
  } finally { gate.mockRestore(); present.mockRestore(); await state.close(); }
});

(process.platform === "linux" ? test : test.skip)("worker startup failure is ready to retry without repeating a dispatched presentation", async () => {
  const state = await fixture();
  const startup = new OrbitError("NATIVE_FAILED", "Private worker startup failed");
  const actualPresent = NativeBackend.present;
  let privateFailure: unknown;
  const present = spyOn(NativeBackend, "present").mockImplementation(async (...args) => {
    try { return await actualPresent.apply(NativeBackend, args); }
    catch (error) { privateFailure = error; throw error; }
  });
  let creates = 0, requests = 0;
  const create = spyOn(NativeWorker, "create").mockImplementation(async directory => {
    if (++creates === 1) throw startup;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "worker.log"), "startup recovery fixture\n", { mode: 0o600 });
    return { request: async () => { requests++; return acknowledgement; }, close: async () => {} } as unknown as NativeWorker;
  });
  const request = { method: "native.present", params };
  try {
    await expect(state.sessions.dispatch(request)).rejects.toMatchObject({ code: "PRESENTATION_NOT_READY" });
    expect(privateFailure).toMatchObject({ code: "PRESENTATION_NOT_READY", cause: startup });
    expect(requests).toBe(0);
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 3 } }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(state.sessions.dispatch(request)).resolves.toEqual(acknowledgement);
    await expect(state.sessions.dispatch(request)).resolves.toEqual(acknowledgement);
    expect(creates).toBe(2); expect(requests).toBe(1);
  } finally { present.mockRestore(); create.mockRestore(); await state.close(); }
});

test("update admission blocks presentation and read workers, including persistent recovery", async () => {
  const state = await fixture();
  const present = spyOn(NativeBackend, "present").mockResolvedValue(acknowledgement);
  const monitors = spyOn(NativeBackend, "monitors").mockResolvedValue({ monitors: [] });
  try {
    const lease = await state.sessions.dispatch({ method: "update.begin" }) as { token: string };
    await expect(state.sessions.dispatch({ method: "native.present", params })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    await expect(state.sessions.dispatch({ method: "native.monitors" })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    await state.sessions.dispatch({ method: "update.end", params: { token: lease.token } });
    await mkdir(join(state.root, "update"), { recursive: true });
    await writeFile(join(state.root, "update/activation-recovery.json"), "{}");
    await expect(state.sessions.dispatch({ method: "native.present", params })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    expect(present).not.toHaveBeenCalled(); expect(monitors).not.toHaveBeenCalled();
  } finally { present.mockRestore(); monitors.mockRestore(); await state.close(); }
});

test("shutdown waits for admitted presentation and stops queued or late mutation", async () => {
  const state = await fixture();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const present = spyOn(NativeBackend, "present").mockImplementation(async () => {
    started.resolve(); await release.promise; return acknowledgement;
  });
  let stopping: Promise<void> | undefined;
  try {
    const first = state.sessions.dispatch({ method: "native.present", params });
    await started.promise;
    await expect(state.sessions.dispatch({ method: "update.begin" })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    const queued = state.sessions.dispatch({ method: "native.present", params: { ...params, requestId: "queued" } });
    const queuedOutcome = queued.then(value => value, error => error);
    stopping = state.sessions.close();
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, requestId: "late" } }))
      .rejects.toMatchObject({ code: "SESSION_CLOSED" });
    release.resolve();
    expect(await first).toEqual(acknowledgement);
    expect(await queuedOutcome).toMatchObject({ code: "SESSION_CLOSED" });
    await stopping;
    expect(present).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); await stopping; present.mockRestore(); await state.close(); }
});

(process.platform === "linux" ? test : test.skip)("standalone presentation retains private worker diagnostics and returns uncertainty after lost acknowledgement", async () => {
  const state = await fixture();
  const options = { planPath: "/fixture/host.json", controlDirectory: join(state.root, "control") };
  const methods: string[] = [];
  const create = spyOn(NativeWorker, "create").mockImplementation(async directory => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "worker.log"), "presentation fixture diagnostic\n", { mode: 0o600 });
    return { request: async (method: string) => { methods.push(method); throw new OrbitError("NATIVE_FAILED", "Reply lost"); },
      close: async () => {} } as unknown as NativeWorker;
  });
  try {
    await expect(NativeBackend.present(options, { workspace: 2, monitor: "HDMI-A-5" }))
      .rejects.toMatchObject({ code: "PRESENTATION_UNCONFIRMED", message: expect.stringContaining("may have changed") });
    expect(methods).toEqual(["present"]);
    const retained = await readdir(join(options.controlDirectory, "broker-logs"));
    expect(retained).toHaveLength(1);
    const name = retained[0];
    if (!name) throw new Error("Missing retained presentation diagnostic");
    expect(await readFile(join(options.controlDirectory, "broker-logs", name, "worker.log"), "utf8"))
      .toBe("presentation fixture diagnostic\n");
  } finally { create.mockRestore(); await state.close(); }
});

(process.platform === "linux" ? test : test.skip)("presentation cleanup failure stays uncertain and never repeats the acknowledged mutation", async () => {
  const state = await fixture();
  const directories: string[] = [];
  let requests = 0, closes = 0;
  const create = spyOn(NativeWorker, "create").mockImplementation(async directory => {
    directories.push(dirname(directory));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "worker.log"), "private cleanup diagnostic\n", { mode: 0o600 });
    return { request: async () => { requests++; return acknowledgement; }, close: async () => {
      closes++; throw new OrbitError("BACKEND_ERROR", "private cleanup failure");
    } } as unknown as NativeWorker;
  });
  const request = { method: "native.present", params };
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(state.sessions.dispatch(request)).rejects.toMatchObject({
        code: "PRESENTATION_UNCONFIRMED", message: expect.stringContaining("may have changed"),
      });
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 3 } }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(requests).toBe(1); expect(closes).toBe(1); expect(create).toHaveBeenCalledTimes(1);
    const directory = directories[0];
    if (!directory) throw new Error("Missing owned failed-cleanup workspace");
    expect(await readFile(join(directory, "worker/worker.log"), "utf8")).toBe("private cleanup diagnostic\n");
  } finally {
    create.mockRestore(); await state.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});

(process.platform === "linux" ? test : test.skip)("presentation worker uses native read and admitted mutation paths without focus dispatch", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_presentation_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
});
