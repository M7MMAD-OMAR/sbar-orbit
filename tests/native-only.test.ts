import { expect, test, spyOn } from "bun:test";
import { startBroker, call } from "../src/ipc";
import { listSettings } from "../src/desktop-settings";
import { NativeBackend } from "../src/hyprland";
import { NativeWorker } from "../src/native-worker";
import { orbitActionSchema } from "../src/mcp";
import { Sessions } from "../src/session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("private desktop aliases and the omitted backend are refused before startup", async () => {
  const broker = await startBroker();
  try {
    for (const backend of [undefined, "system", "fedora", "browser"]) {
      await expect(call(broker.socket, "session.create", { backend, visible: false }))
        .rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
    expect(await call(broker.socket, "session.list")).toEqual([]);
  } finally { await broker.close(); }
});

test("the direct session API also refuses private desktop creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-native-only-"));
  const sessions = new Sessions(root);
  try {
    await expect(sessions.create({ backend: "system", visible: false }))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await sessions.close(); await rm(root, { recursive: true, force: true }); }
});

test("browser viewers and profile APIs are unavailable, including non-launching previews", async () => {
  const broker = await startBroker();
  try {
    for (const method of ["preview.open", "viewer.browsers", "profiles.list", "session.account.save", "session.restore"])
      await expect(call(broker.socket, method, { launch: false })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await broker.close(); }
});

test("settings offer no browser viewer or hidden desktop option", async () => {
  const keys = (await listSettings()).map(setting => setting.key);
  for (const key of ["hiddenSessions", "viewerBrowser", "viewerAppWindow"])
    expect(keys).not.toContain(key);
});

test("capability reporting advertises no private desktop backend", async () => {
  const broker = await startBroker();
  try {
    const report = await call(broker.socket, "doctor") as { backends: string[]; sessionMode: string };
    expect(report.backends).not.toContain("fedora");
    expect(report.backends).not.toContain("browser");
    expect(report.sessionMode).toBe("native-only");
  } finally { await broker.close(); }
});

test("native creation without an owner application cannot create a substitute session", async () => {
  const worker = spyOn(NativeWorker, "create").mockRejectedValue(new Error("must not start"));
  try {
    await expect(NativeBackend.create("", { planPath: "/fixture/plan", controlDirectory: "/fixture/control" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(worker).not.toHaveBeenCalled();
  } finally { worker.mockRestore(); }
});

test("private launch and browser actions are absent from the MCP action contract", () => {
  for (const action of [{ type: "launch", argv: ["firefox"] }, { type: "launch-installed", applicationId: "app.desktop" },
    { type: "navigate", url: "https://example.com" }, { type: "desktop", desktopId: "2" },
    { type: "launch-app", app: "zen", profile: "active" }])
    expect(orbitActionSchema.safeParse(action).success).toBe(false);
});
