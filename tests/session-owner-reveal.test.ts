import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeBackend } from "../src/hyprland";
import { Sessions } from "../src/session";
import type { Caller } from "../src/caller";

const owner: Caller = { id: "owner", label: "Owner", role: "owner", kind: "cli", verified: true };
const agent: Caller = { id: "conv:fixture", label: "Agent", role: "agent", kind: "client", verified: true };
test("only explicit owner session reveal navigates, never list presence observe or agent role spoofing", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-owner-reveal-")); let reveals = 0;
  const appId = "a".repeat(32), windowId = "b".repeat(32);
  const create = spyOn(NativeBackend, "create").mockResolvedValue({
    capabilities: ["observe"], surface: { width: 10, height: 10 },
    handoff: { workspace: 4, appId, selectedWindowId: windowId, scope: "entire-wayland-client", clipboard: "shared", pointer: { x: 1, y: 1 }, windows: [{ appId, windowId, title: "Owned fixture", width: 10, height: 10 }] },
    reveal: async () => { reveals++; return { revealed: true, workspace: 4, windowId }; },
    presence: async () => ({ title: "Owned fixture" }), observe: async () => ({ mimeType: "image/png", image: "AA==" }),
    onClose() {}, close: async () => {},
  } as never);
  const sessions = new Sessions(root, undefined, undefined, { planPath: "/fixture/plan", controlDirectory: join(root, "control") });
  try {
    const created = await sessions.dispatch({ method: "session.create", params: { backend: "native", handoff: { workspace: 4 } } }, agent) as { sessionId: string };
    const params = { sessionId: created.sessionId };
    await sessions.dispatch({ method: "session.list" }, owner);
    await sessions.dispatch({ method: "session.presence", params }, owner);
    await sessions.dispatch({ method: "session.observe", params }, agent);
    expect(reveals).toBe(0);
    for (const caller of [agent, { ...owner, verified: false }])
      await expect(sessions.dispatch({ method: "session.reveal", params: { ...params, role: "owner", workspace: 4 } }, caller)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(reveals).toBe(0);
    await expect(sessions.dispatch({ method: "native.present", params: { requestId: "not-owner", workspace: 4, monitor: "DP-1" } }, agent)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(sessions.dispatch({ method: "session.reveal", params: { ...params, address: "0x123" } }, owner)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(reveals).toBe(0);
    expect(await sessions.dispatch({ method: "session.reveal", params }, owner)).toEqual({ revealed: true, workspace: 4, windowId });
    expect(reveals).toBe(1);
    await sessions.dispatch({ method: "session.stop", params }, owner);
    await expect(sessions.dispatch({ method: "session.reveal", params }, owner)).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(reveals).toBe(1);
  } finally {
    try { await sessions.close(); await sessions.diagnostics.flush(); } finally { create.mockRestore(); }
    await rm(root, { recursive: true, force: true });
  }
});
