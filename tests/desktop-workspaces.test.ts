import { expect, test } from "bun:test";
import { parseNativeAction } from "../src/fedora";
import { classify } from "../src/policy";
import { SwayWorkspaceAdapter } from "../src/desktop-workspaces";
import { startBroker, call } from "../src/ipc";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

test("desktop action contract lists workspaces and windows", () => {
  expect(parseNativeAction({ type: "desktops" })).toEqual({ type: "desktops" });
  expect(parseNativeAction({ type: "list-windows" })).toEqual({ type: "list-windows" });
});

test("desktop action contract selects a desktop with an opaque identity", () => {
  expect(parseNativeAction({ type: "desktop", desktopId: "2" })).toEqual({ type: "desktop", desktopId: "2" });
});

test("window movement requires an explicit stable window and desktop", () => {
  expect(parseNativeAction({ type: "move-window", windowId: "53", desktopId: "2" }))
    .toEqual({ type: "move-window", windowId: "53", desktopId: "2" });
  expect(() => parseNativeAction({ type: "move-window", tab: 1, desktopId: "2" })).toThrow();
});

test("desktop actions reject unrecognized host selectors and malformed identities", () => {
  for (const action of [
    { type: "desktops", socket: "/owner/socket" },
    { type: "desktop", desktopId: "" },
    { type: "desktop", desktopId: "2", workspace: 3 },
    { type: "move-window", windowId: "53", desktopId: "2", host: true },
  ]) expect(() => parseNativeAction(action)).toThrow();
});

test("desktop discovery is read-only while selection and movement require writes", () => {
  expect(classify("desktops")).toBe("read");
  expect(classify("list-windows")).toBe("read");
  expect(classify("desktop")).toBe("write");
  expect(classify("move-window")).toBe("write");
});

test("workspace adapter refuses stale or foreign window handles before sending commands", async () => {
  const commands: string[] = [];
  const transport = {
    tree: async () => ({ nodes: [{ type: "workspace", num: 1, nodes: [{ id: 53, pid: 100, name: "Fixture", focused: true }] }] }),
    desktops: async () => [{ num: 1, name: "1", focused: true }],
    command: async (value: string) => { commands.push(value); },
  };
  const a = new SwayWorkspaceAdapter(transport), b = new SwayWorkspaceAdapter(transport);
  const window = (await a.listWindows())[0];
  if (!window) throw new Error("Missing fixture window");
  await expect(b.moveWindow(window.windowId, "2")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(a.moveWindow(window.windowId, "2; exec bad")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(a.moveWindow("53", "2")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(commands).toEqual([]);
});

test("workspace adapter verifies movement instead of trusting a command acknowledgement", async () => {
  const adapter = new SwayWorkspaceAdapter({
    tree: async () => ({ type: "workspace", num: 1, nodes: [{ id: 53, pid: 100 }] }),
    desktops: async () => [{ num: 1, name: "1", focused: true }],
    command: async () => [{ success: true }],
  });
  const window = (await adapter.listWindows())[0];
  if (!window) throw new Error("Missing fixture window");
  await expect(adapter.moveWindow(window.windowId, "2")).rejects.toMatchObject({ code: "BACKEND_FAILED" });
});

test("workspace movement refuses unknown active state before acting", async () => {
  const commands: string[] = [];
  const adapter = new SwayWorkspaceAdapter({
    tree: async () => ({ type: "workspace", num: 1, nodes: [{ id: 53, pid: 100 }] }),
    desktops: async () => [{ num: 1, name: "1", focused: false }],
    command: async value => { commands.push(value); },
  });
  const window = (await adapter.listWindows())[0];
  if (!window) throw new Error("Missing fixture window");
  await expect(adapter.moveWindow(window.windowId, "2")).rejects.toMatchObject({ code: "BACKEND_FAILED" });
  expect(commands).toEqual([]);
});

test("workspace movement reports an unexpected active desktop change", async () => {
  let moved = false;
  const adapter = new SwayWorkspaceAdapter({
    tree: async () => ({ type: "workspace", num: moved ? 2 : 1, nodes: [{ id: 53, pid: 100 }] }),
    desktops: async () => [{ num: moved ? 2 : 1, name: moved ? "2" : "1", focused: true }],
    command: async () => { moved = true; },
  });
  const window = (await adapter.listWindows())[0];
  if (!window) throw new Error("Missing fixture window");
  await expect(adapter.moveWindow(window.windowId, "2")).rejects.toMatchObject({ code: "BACKEND_FAILED" });
});

(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("private desktops move one exact application and preserve the active desktop", async () => {
  const root = await mkdtemp("/tmp/orbit-desktop-acceptance-");
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "system",
      policy: { mode: "autonomous", origins: "any", allow: ["read", "write"], deny: ["irreversible"] } }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    await act({ type: "desktop", desktopId: "1" });
    for (const name of ["first", "second"])
      await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", resolve("experiments/fedora-display/fixture.py"), join(root, name + ".json")] });
    const before = await act({ type: "list-windows" }) as { windows: { windowId: string; desktopId: string; pid: number }[] };
    expect(before.windows).toHaveLength(2);
    const [first, second] = before.windows;
    if (!first || !second) throw new Error("Two fixture windows required");
    expect(await act({ type: "move-window", windowId: second.windowId, desktopId: "2" }))
      .toMatchObject({ window: { windowId: second.windowId, desktopId: "2", pid: second.pid } });
    const desktops = await act({ type: "desktops" }) as { desktops: { desktopId: string; active: boolean }[] };
    expect(desktops.desktops).toContainEqual(expect.objectContaining({ desktopId: "1", active: true }));
    expect(desktops.desktops).toContainEqual(expect.objectContaining({ desktopId: "2", active: false }));
    const after = await act({ type: "list-windows" }) as typeof before;
    expect(after.windows).toContainEqual(expect.objectContaining({ windowId: first.windowId, desktopId: "1", pid: first.pid }));
    await act({ type: "desktop", desktopId: "2" });
    expect(await act({ type: "desktops" })).toMatchObject({ desktops: expect.arrayContaining([expect.objectContaining({ desktopId: "2", active: true })]) });
    await expect(act({ type: "move-window", windowId: "foreign", desktopId: "1" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await call(broker.socket, "session.stop", session);
  } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
}, 60000);
