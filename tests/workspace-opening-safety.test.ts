import { expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Caller } from "../src/caller";
import { OrbitError } from "../src/errors";
import { NativeBackend } from "../src/hyprland";
import { Sessions } from "../src/session";

// Actual broker allocation/dispatch, injected backend boundaries only. No window,
// compositor, worker startup, process liveness or native presentation qualification.
const caller = (id = "owned"): Caller => ({ id: "conv:" + id, label: "Owned fixture", role: "agent", kind: "client", verified: true });
const request = (id: string, workspace?: number) => ({ method: "native.open", params: {
  requestId: id, applicationId: "org.example.Owned.desktop", ...(workspace === undefined ? {} : { workspace }),
} });
async function fixture() {
  const prefix = "orbit-workspace-opening-", created = await mkdtemp(join(tmpdir(), prefix));
  const root = await realpath(created), parent = await realpath(dirname(created));
  const state = { occupied: [] as number[], shown: [] as number[] };
  const inventory = spyOn(NativeBackend, "workspaceInventory").mockImplementation(async () => ({ occupied: [...state.occupied], shown: [...state.shown] }));
  const open = spyOn(NativeBackend, "openApplication").mockImplementation(async (_options, target) => ({ opened: true, workspace: target.workspace }));
  const present = spyOn(NativeBackend, "present").mockRejectedValue(new Error("No presentation permitted by opening fixture"));
  const monitors = spyOn(NativeBackend, "monitors").mockRejectedValue(new Error("No monitor-only fallback permitted"));
  const create = spyOn(NativeBackend, "create").mockRejectedValue(new Error("No handoff expected in this opening fixture"));
  const sessions = new Sessions(root, undefined, undefined,
    { planPath: "/owned-fixture/host.json", controlDirectory: join(root, "control") }, join(root, "update"), { workspacePool: [1, 10] });
  const assertNoPresentation = () => { expect(present).not.toHaveBeenCalled(); expect(monitors).not.toHaveBeenCalled(); };
  const close = async () => {
    try { await sessions.close(); await sessions.diagnostics.flush(); }
    finally { inventory.mockRestore(); open.mockRestore(); present.mockRestore(); monitors.mockRestore(); create.mockRestore(); }
    const info = await lstat(root);
    if (dirname(root) !== parent || !basename(root).startsWith(prefix) || await realpath(root) !== root
        || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing cleanup outside exact owned workspace fixture");
    await rm(root, { recursive: true, force: true });
  };
  return { state, sessions, inventory, open, present, monitors, create, assertNoPresentation, close };
}

test("inventory excludes invisible owner or untracked-agent windows and displayed empty workspaces", async () => {
  const f = await fixture();
  try {
    // Occupancy includes windows absent from broker sessions, regardless of whether
    // their owner/agent is alive. A shown workspace is unsafe even with no window.
    f.state.occupied = [1, 3]; f.state.shown = [2];
    expect(await f.sessions.dispatch(request("first"), caller())).toEqual({ opened: true, workspace: 4, allocated: true });
    expect(f.open.mock.calls[0]?.[1].workspace).toBe(4);
    expect(f.state).toEqual({ occupied: [1, 3], shown: [2] });
    expect(f.create).not.toHaveBeenCalled(); f.assertNoPresentation();
  } finally { await f.close(); }
});

test("fresh requests by the same caller reserve fresh empty destinations even when inventory has not mapped a window", async () => {
  const f = await fixture();
  try {
    const who = caller();
    const first = await f.sessions.dispatch(request("first"), who);
    expect(first).toMatchObject({ workspace: 1, allocated: true });
    expect(await f.sessions.dispatch(request("second"), who)).toMatchObject({ workspace: 2, allocated: true });
    expect(await f.sessions.dispatch(request("first"), who)).toEqual(first);
    expect(f.open).toHaveBeenCalledTimes(2); expect(f.inventory).toHaveBeenCalledTimes(2);
    f.assertNoPresentation();
  } finally { await f.close(); }
});

test("all first ten occupied or shown refuses without launching outside the pool", async () => {
  const f = await fixture();
  try {
    f.state.occupied = [1, 3, 5, 7, 9]; f.state.shown = [2, 4, 6, 8, 10];
    await expect(f.sessions.dispatch(request("full"), caller())).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    expect(f.open).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); f.assertNoPresentation();
  } finally { await f.close(); }
});

test("unavailable authoritative inventory refuses with no monitor fallback or launch", async () => {
  const f = await fixture();
  try {
    f.inventory.mockRejectedValue(new OrbitError("BACKEND_ERROR", "Cannot determine empty numbered workspaces"));
    const operation = request("unknown");
    await expect(f.sessions.dispatch(operation, caller())).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    await expect(f.sessions.dispatch(operation, caller())).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    expect(f.inventory).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled(); f.assertNoPresentation();
  } finally { await f.close(); }
});

test("concurrent retries deduplicate while distinct callers or requests get distinct destinations", async () => {
  const f = await fixture();
  try {
    const a = caller("a"), b = caller("b"), same = request("same");
    const [first, retry, other, next] = await Promise.all([
      f.sessions.dispatch(same, a), f.sessions.dispatch(same, a), f.sessions.dispatch(same, b),
      f.sessions.dispatch(request("next"), a),
    ]);
    expect(first).toEqual(retry);
    expect([first, other, next].map(value => (value as { workspace: number }).workspace).sort((x, y) => x - y)).toEqual([1, 2, 3]);
    expect(f.open).toHaveBeenCalledTimes(3); expect(f.inventory).toHaveBeenCalledTimes(3); f.assertNoPresentation();
  } finally { await f.close(); }
});

test("explicit occupied or shown targets refuse and a free target never invokes presentation", async () => {
  const f = await fixture();
  try {
    f.state.occupied = [1]; f.state.shown = [2];
    for (const workspace of [1, 2])
      await expect(f.sessions.dispatch(request("busy-" + workspace, workspace), caller())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(f.open).not.toHaveBeenCalled();
    expect(await f.sessions.dispatch(request("free", 3), caller())).toEqual({ opened: true, workspace: 3 });
    expect(f.open).toHaveBeenCalledTimes(1); f.assertNoPresentation();
  } finally { await f.close(); }
});

test("uncertain explicit opening reserves its destination against fresh explicit and automatic requests", async () => {
  const f = await fixture();
  try {
    f.open.mockRejectedValueOnce(new OrbitError("NATIVE_FAILED", "Owned uncertain opening"));
    const original = request("uncertain", 1), a = caller("a"), b = caller("b");
    await expect(f.sessions.dispatch(original, a)).rejects.toMatchObject({ code: "NATIVE_FAILED" });
    await expect(f.sessions.dispatch(request("fresh-explicit", 1), b)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(await f.sessions.dispatch(request("fresh-auto"), b)).toMatchObject({ workspace: 2, allocated: true });
    await expect(f.sessions.dispatch(original, a)).rejects.toMatchObject({ code: "NATIVE_FAILED" });
    expect(f.open).toHaveBeenCalledTimes(2); f.assertNoPresentation();
  } finally { await f.close(); }
});

test("an automatic reservation also blocks a fresh explicit request on that still-unmapped workspace", async () => {
  const f = await fixture();
  try {
    await f.sessions.dispatch(request("auto"), caller());
    await expect(f.sessions.dispatch(request("explicit", 1), caller())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(f.open).toHaveBeenCalledTimes(1); f.assertNoPresentation();
  } finally { await f.close(); }
});


test("the caller's own retained selected session also excludes its workspace when inventory is empty", async () => {
  const f = await fixture();
  try {
    const appId = "a".repeat(32), windowId = "b".repeat(32);
    f.create.mockResolvedValue({ capabilities: ["click"], surface: { width: 10, height: 10 },
      handoff: { workspace: 1, appId, selectedWindowId: windowId, scope: "entire-wayland-client", clipboard: "shared", pointer: { x: 1, y: 1 },
        windows: [{ appId, windowId, title: "Owned selected fixture", width: 10, height: 10 }] },
      parseAction: (value: unknown) => value, act: async () => ({ response: "ok" }), presence: async () => ({}),
      onClose() {}, close: async () => {},
    } as never);
    const who = caller();
    await f.sessions.dispatch({ method: "session.create", params: { handoff: { workspace: 1 }, agentName: "Owned fixture", taskName: "Selected existing window" } }, who);
    expect(f.open).not.toHaveBeenCalled();
    expect(await f.sessions.dispatch(request("new-window"), who)).toMatchObject({ workspace: 2, allocated: true });
    expect(f.create).toHaveBeenCalledTimes(1); f.assertNoPresentation();
  } finally { await f.close(); }
});
