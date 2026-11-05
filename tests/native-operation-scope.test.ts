import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "../src/caller";
import { OrbitError } from "../src/errors";
import { NativeBackend } from "../src/hyprland";
import { Sessions } from "../src/session";
import { startBroker } from "../src/ipc";

const caller = (id: string): Caller => ({ id: `conv:${id}`, label: id, role: "agent", kind: "client", verified: true });
const ownerCaller = (id: string): Caller => ({ ...caller(id), role: "owner" });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-operation-scope-"));
  const sessions = new Sessions(root, undefined, undefined,
    { planPath: "/fixture/host.json", controlDirectory: join(root, "control") }, join(root, "update"));
  const inventory = spyOn(NativeBackend, "workspaceInventory").mockResolvedValue({ occupied: [], shown: [] });
  return { sessions, inventory, close: async () => { try { await sessions.close(); } finally { inventory.mockRestore(); } await rm(root, { recursive: true, force: true }); } };
}

test("process-scoped mutations refuse across all external transports, while reads remain available", async () => {
  const state = await fixture();
  const open = spyOn(NativeBackend, "openApplication").mockResolvedValue({ opened: true });
  const present = spyOn(NativeBackend, "present").mockResolvedValue({ visible: true });
  const monitors = spyOn(NativeBackend, "monitors").mockResolvedValue({ monitors: [] });
  try {
    for (const kind of ["cli", "adapter", "client", "unidentified"] as const) {
      const cli: Caller = { ...caller("process"), id: "proc:100:1", kind };
      await expect(state.sessions.dispatch({ method: "native.open", params: { requestId: "same", workspace: 25, applicationId: "org.example.App.desktop" } }, cli))
        .rejects.toMatchObject({ code: "CONVERSATION_REQUIRED" });
      await expect(state.sessions.dispatch({ method: "native.present", params: { requestId: "same", workspace: 25, monitor: "DP-1" } }, cli))
        .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      expect(await state.sessions.dispatch({ method: "native.monitors" }, cli)).toEqual({ monitors: [] });
    }
    expect(open).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  } finally { open.mockRestore(); present.mockRestore(); monitors.mockRestore(); await state.close(); }
});

test.skipIf(process.platform !== "linux")("real CLI processes retain conversation and JSON operation identities without owner authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-cli-operation-scope-"));
  const broker = await startBroker({ native: { planPath: "/fixture/host.json", controlDirectory: join(root, "control") } });
  const open = spyOn(NativeBackend, "openApplication").mockRejectedValue(new OrbitError("NATIVE_FAILED", "Uncertain fixture"));
  const present = spyOn(NativeBackend, "present").mockRejectedValue(new OrbitError("PRESENTATION_UNCONFIRMED", "Uncertain fixture"));
  const inventory = spyOn(NativeBackend, "workspaceInventory").mockResolvedValue({ occupied: [], shown: [] });
  const cli = async (command: string, params: unknown, conversation?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, ORBIT_SOCKET: broker.socket, ORBIT_USAGE_DIR: join(root, "usage"), ORBIT_REQUEST_ID: "must-not-override-json", ORBIT_CONVERSATION_ID: conversation };
    delete env.ORBIT_OWNER;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), command, JSON.stringify(params)], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, error: JSON.parse(err).error, code };
  };
  try {
    for (const [command, params, code] of [
      ["native-open", { requestId: "from-json", applicationId: "org.example.App.desktop", workspace: 25 }, "NATIVE_FAILED"],
      ["native-present", { requestId: "from-json", workspace: 25, monitor: "DP-1" }, "APPROVAL_REQUIRED"],
    ] as const) {
      expect((await cli(command, params)).error.code).toBe(command === "native-present" ? "APPROVAL_REQUIRED" : "CONVERSATION_REQUIRED");
      expect((await cli(command, params, "fixture-a")).error.code).toBe(code);
      expect((await cli(command, params, "fixture-a")).error.code).toBe(code);
      expect((await cli(command, { ...params, requestId: "new-json", ...(command === "native-open" ? { workspace: 26 } : {}) }, "fixture-a")).error.code).toBe(code);
      expect((await cli(command, { ...params, ...(command === "native-open" ? { workspace: 27 } : {}) }, "fixture-b")).error.code).toBe(code);
    }
    expect(open).toHaveBeenCalledTimes(3);
    expect(present).not.toHaveBeenCalled();
  } finally { open.mockRestore(); present.mockRestore(); inventory.mockRestore(); await broker.close(); await rm(root, { recursive: true, force: true }); }
});

test("opening and workspace allocation identities are caller-scoped, including concurrent retries", async () => {
  const state = await fixture();
  const open = spyOn(NativeBackend, "openApplication").mockImplementation(async (_options, target) => ({ workspace: target.workspace, receipt: target.workspace }));
  const inventory = state.inventory;
  const request = { method: "native.open", params: { requestId: "same-id", applicationId: "org.example.App.desktop" } };
  const a = caller("caller:a"), b = caller("caller:b");
  try {
    const [first, retry, other] = await Promise.all([state.sessions.dispatch(request, a), state.sessions.dispatch(request, a), state.sessions.dispatch(request, b)]);
    expect(first).toEqual(retry);
    expect(first).not.toEqual(other);
    expect(open).toHaveBeenCalledTimes(2);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(await state.sessions.dispatch(request, b)).toEqual(other);
    await expect(state.sessions.dispatch({ ...request, params: { ...request.params, workspace: 50 } }, a))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  } finally { open.mockRestore(); await state.close(); }
});

test("one caller approval refusal cannot evict another caller uncertain opening", async () => {
  const state = await fixture();
  const open = spyOn(NativeBackend, "openApplication")
    .mockRejectedValueOnce(new OrbitError("APPROVAL_REQUIRED", "Protected"))
    .mockRejectedValueOnce(new OrbitError("NATIVE_FAILED", "Uncertain"))
    .mockResolvedValue({ opened: true });
  const request = { method: "native.open", params: { requestId: "same-id", applicationId: "org.example.App.desktop", workspace: 25 } };
  const a = caller("a"), b = caller("b");
  try {
    await expect(state.sessions.dispatch(request, a)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const other = { ...request, params: { ...request.params, workspace: 26 } };
    await expect(state.sessions.dispatch(other, b)).rejects.toMatchObject({ code: "NATIVE_FAILED" });
    await expect(state.sessions.dispatch(request, a)).resolves.toEqual({ opened: true });
    await expect(state.sessions.dispatch(other, b)).rejects.toMatchObject({ code: "NATIVE_FAILED" });
    expect(open).toHaveBeenCalledTimes(3);
  } finally { open.mockRestore(); await state.close(); }
});

test("presentation receipts and conflicts cannot leak between callers", async () => {
  const state = await fixture();
  const present = spyOn(NativeBackend, "present").mockImplementation(async (_options, target) => ({ ...target, receipt: target.workspace }));
  const params = { requestId: "same-id", workspace: 25, monitor: "DP-1" };
  const a = ownerCaller("a"), b = ownerCaller("b");
  try {
    const first = await state.sessions.dispatch({ method: "native.present", params }, a);
    const other = await state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 26 } }, b);
    expect(first).not.toEqual(other);
    expect(await state.sessions.dispatch({ method: "native.present", params }, a)).toEqual(first);
    await expect(state.sessions.dispatch({ method: "native.present", params: { ...params, workspace: 26 } }, a))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(present).toHaveBeenCalledTimes(2);
  } finally { present.mockRestore(); await state.close(); }
});

test("operation keys cannot alias through caller/request delimiter injection", async () => {
  const state = await fixture();
  const present = spyOn(NativeBackend, "present").mockResolvedValue({ visible: true });
  const params = { requestId: "b:c", workspace: 25, monitor: "DP-1" };
  try {
    await state.sessions.dispatch({ method: "native.present", params }, ownerCaller("a"));
    await state.sessions.dispatch({ method: "native.present", params: { ...params, requestId: "c" } }, ownerCaller("a:b"));
    expect(present).toHaveBeenCalledTimes(2);
    await state.sessions.dispatch({ method: "native.present", params }, ownerCaller("a"));
    expect(present).toHaveBeenCalledTimes(2);
  } finally { present.mockRestore(); await state.close(); }
});

test("uncertain presentation stays cached per caller without preventing another caller dispatch", async () => {
  const state = await fixture();
  const present = spyOn(NativeBackend, "present")
    .mockRejectedValueOnce(new OrbitError("PRESENTATION_UNCONFIRMED", "Uncertain"))
    .mockResolvedValue({ visible: true });
  const request = { method: "native.present", params: { requestId: "same-id", workspace: 25, monitor: "DP-1" } };
  try {
    await expect(state.sessions.dispatch(request, ownerCaller("a"))).rejects.toMatchObject({ code: "PRESENTATION_UNCONFIRMED" });
    expect(await state.sessions.dispatch(request, ownerCaller("b"))).toEqual({ visible: true });
    await expect(state.sessions.dispatch(request, ownerCaller("a"))).rejects.toMatchObject({ code: "PRESENTATION_UNCONFIRMED" });
    expect(present).toHaveBeenCalledTimes(2);
  } finally { present.mockRestore(); await state.close(); }
});
