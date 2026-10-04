import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, readdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeWorker, nativeOptionsFromEnv } from "../src/native-worker";
import { orbitActionSchema } from "../src/mcp";

const enabled = process.platform === "linux" ? test : test.skip;
const fixture = join(import.meta.dir, "../experiments/ghost-cursor/native_worker_fixture.py");
const options = { planPath: "/tmp/unused-native-plan", controlDirectory: "/tmp/unused-native-control" };

const descriptors = async (path: string) => {
  const links = await Promise.all((await readdir("/proc/self/fd")).map(async fd => {
    try { return await readlink("/proc/self/fd/" + fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }));
  return links.filter(link => link === path).length;
};

enabled("native unexpected exit releases its private diagnostic descriptor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-worker-exit-"));
  const worker = await NativeWorker.create(join(directory, "worker"), options, ["/usr/bin/python3", fixture]);
  const closed = new Promise<void>(resolve => worker.onClose(resolve));
  try {
    expect(await descriptors(join(directory, "worker/worker.log"))).toBeGreaterThan(0);
    await expect(worker.request("exit", {})).rejects.toThrow();
    await closed;
    expect(await descriptors(join(directory, "worker/worker.log"))).toBe(0);
    await expect(worker.close()).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

enabled("native fatal response reaps a stopped worker without an explicit stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-worker-stopped-"));
  const worker = await NativeWorker.create(join(directory, "worker"), options, ["/usr/bin/python3", fixture]);
  const closed = new Promise<void>(resolve => worker.onClose(resolve));
  try {
    await expect(worker.request("wrong-id-stop", {})).rejects.toThrow();
    await Promise.race([closed, Bun.sleep(22_000).then(() => { throw new Error("Fatal worker survived automatic cleanup"); })]);
    expect(await descriptors(join(directory, "worker/worker.log"))).toBe(0);
    await expect(worker.close()).rejects.toThrow("Native worker exchange or cleanup failed");
  } finally {
    worker.child.kill("SIGCONT"); worker.child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

enabled("native framed worker preserves split Unicode, ordered replies and EOF cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-worker-test-"));
  const worker = await NativeWorker.create(join(directory, "worker"), options, ["/usr/bin/python3", fixture]);
  try {
    const responses = await Promise.all([worker.request("first", {}), worker.request("second", {})]);
    expect(responses).toEqual([{ value: "split 😀" }, { value: "split 😀" }]);
    expect((await stat(join(directory, "worker/worker.log"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "worker"))).mode & 0o777).toBe(0o700);
    let closed = 0;
    worker.onClose(() => closed++);
    await worker.close();
    expect(closed).toBe(1);
    await expect(worker.request("late", {})).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const method of ["wrong-id", "bad-error"]) enabled(`native worker rejects ${method} without losing the pending promise`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-worker-error-"));
  const worker = await NativeWorker.create(join(directory, "worker"), options, ["/usr/bin/python3", fixture]);
  try {
    await expect(worker.request(method, {})).rejects.toThrow();
    await expect(worker.close()).rejects.toThrow("Native worker exchange or cleanup failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

enabled("native worker bounds queued exchanges and outgoing framing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-worker-limit-"));
  const worker = await NativeWorker.create(join(directory, "worker"), options, ["/usr/bin/python3", fixture]);
  try {
    await expect(worker.request("large", { text: "x".repeat(65536) })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const pending = Array.from({ length: 128 }, () => worker.request("queued", {}));
    const rejected = worker.request("overflow", {});
    await expect(rejected).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    await Promise.all(pending);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native MCP action schema retains explicit targets and fractional coordinates", () => {
  const action = { type: "text" as const, appId: "a".repeat(32), windowId: "b".repeat(32), text: "native" };
  expect(orbitActionSchema.parse(action)).toEqual(action);
  const cursor = { appId: action.appId, windowId: action.windowId, type: "cursor" as const, x: 5000.5, y: 12.25 };
  expect(orbitActionSchema.parse(cursor)).toEqual(cursor);
  expect(orbitActionSchema.safeParse({ type: "configure", mode: "full" }).success).toBe(false);
  expect(orbitActionSchema.parse({ type: "launch", argv: ["/usr/bin/true"] })).toEqual({ type: "launch", argv: ["/usr/bin/true"] });
});
