import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { NativeWorker } from "../src/native-worker";
import { tmpdir } from "node:os";
import { NativeBackend, parseNativeOpen } from "../src/hyprland";
import { Sessions } from "../src/session";
import { OrbitError } from "../src/errors";

test("native opening validates literal argv and workspace", () => {
  expect(parseNativeOpen({ workspace: 4, argv: ["google-chrome-stable", "--profile-directory=Profile 1"] })).toEqual({ workspace: 4, argv: ["google-chrome-stable", "--profile-directory=Profile 1"] });
  for (const input of [{ workspace: 0, argv: ["true"] }, { workspace: 4, argv: [] },
    { workspace: 4, argv: ["true\nfalse"] }, { workspace: 4, argv: ["true"], mode: "full" }])
    expect(() => parseNativeOpen(input)).toThrow();
});

test("native opening deduplicates delivery and allows retry after approval denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-open-test-"));
  const sessions = new Sessions(root, undefined, undefined, { planPath: "/fixture/host.json", controlDirectory: "/fixture/control" });
  const original = NativeBackend.openApplication;
  let attempts = 0;
  NativeBackend.openApplication = async () => {
    if (++attempts === 1) throw new OrbitError("APPROVAL_REQUIRED", "Protected approval required");
    return { opened: true };
  };
  const request = { method: "native.open", params: { requestId: "opening-1", workspace: 4, argv: ["true"] } };
  try {
    await expect(sessions.dispatch(request)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(await sessions.dispatch(request)).toEqual({ opened: true });
    expect(await sessions.dispatch(request)).toEqual({ opened: true });
    expect(attempts).toBe(2);
    await expect(sessions.dispatch({ ...request, params: { ...request.params, workspace: 5 } })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  } finally { NativeBackend.openApplication = original; await sessions.close(); await rm(root, { recursive: true, force: true }); }
});

(process.platform === "linux" ? test : test.skip)("opening fixtures bind the window to the launcher and honor protected controls", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_open_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
});


test("native opening preserves approval denial when worker cleanup fails", async () => {
  const denied = new OrbitError("APPROVAL_REQUIRED", "Protected approval required");
  const failedCleanup = new Error("cleanup failed");
  let directory = "";
  const create = spyOn(NativeWorker, "create").mockImplementation(async (path) => {
    directory = path;
    return { request: async () => { throw denied; }, close: async () => { throw failedCleanup; } } as unknown as NativeWorker;
  });
  try {
    await expect(NativeBackend.openApplication({ planPath: "/fixture/host.json", controlDirectory: "/fixture/control" },
      { workspace: 4, argv: ["true"] })).rejects.toBe(denied);
    expect(denied.cause).toBeInstanceOf(AggregateError);
    expect((denied.cause as AggregateError).errors).toEqual([failedCleanup]);
  } finally {
    create.mockRestore();
    if (directory) await rm(join(directory, ".."), { recursive: true, force: true });
  }
});
