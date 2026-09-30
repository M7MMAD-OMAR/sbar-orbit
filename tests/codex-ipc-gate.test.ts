import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { startCodexScopedIpcGate } from "../src/codex-ipc-gate";

type Message = Record<string, unknown>;
const THREAD = "550e8400-e29b-41d4-a716-446655440000";

class FramedPeer {
  private pending = Buffer.alloc(0);
  private queue: Message[] = [];
  private waiters: Array<(value: Message) => void> = [];
  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4) {
        const size = this.pending.readUInt32LE(0);
        if (this.pending.length < size + 4) break;
        const message = JSON.parse(this.pending.subarray(4, size + 4).toString("utf8")) as Message;
        this.pending = this.pending.subarray(size + 4);
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.queue.push(message);
      }
    });
  }
  send(message: Message) {
    const body = Buffer.from(JSON.stringify(message));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([prefix, body]));
  }
  async next(timeoutMs = 2000): Promise<Message> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return Promise.race([
      new Promise<Message>(resolve => this.waiters.push(resolve)),
      Bun.sleep(timeoutMs).then(() => { throw new Error("Timed out waiting for IPC frame"); }),
    ]);
  }
}

async function listen(server: Server, path: string) {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(path, resolveListen);
  });
  await chmod(path, 0o600);
}

test("Codex IPC gate shares one thread and rejects writes, spoofing, and owner claims", async () => {
  const root = await mkdtemp("/tmp/orbit-ipc-gate-test-");
  const ownerDirectory = join(root, "owner");
  const privateHome = join(root, "private-home");
  const ownerPath = join(ownerDirectory, "ipc.sock");
  await mkdir(ownerDirectory, { mode: 0o700 });
  await mkdir(privateHome, { mode: 0o700 });
  let ownerPeer: FramedPeer | undefined;
  const ownerMessages: Message[] = [];
  const owner = createServer(socket => {
    const peer = new FramedPeer(socket);
    ownerPeer = peer;
    void (async () => {
      while (!socket.destroyed) {
        let message: Message;
        try { message = await peer.next(5000); }
        catch { break; }
        ownerMessages.push(message);
        if (message.method === "initialize") peer.send({ type: "response", method: "initialize",
          requestId: message.requestId, resultType: "success", result: { clientId: "owner-assigned-client" } });
      }
    })();
  });
  let gate: Awaited<ReturnType<typeof startCodexScopedIpcGate>> | undefined;
  let client: Socket | undefined;
  try {
    await listen(owner, ownerPath);
    gate = await startCodexScopedIpcGate(privateHome, ownerPath, THREAD);
    client = createConnection({ path: gate.socketPath });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client?.once("connect", resolveConnect);
      client?.once("error", rejectConnect);
    });
    const follower = new FramedPeer(client);
    follower.send({ type: "request", requestId: "init", method: "initialize", version: 1,
      params: { clientType: "desktop", extra: "discard" } });
    expect((await follower.next()).resultType).toBe("success");
    expect(ownerMessages[0]).toEqual({ type: "request", requestId: "init", method: "initialize",
      version: 1, params: { clientType: "desktop" } });

    follower.send({ type: "request", requestId: "write", sourceClientId: "owner-assigned-client",
      method: "thread-follower-start-turn", version: 2,
      params: { conversationId: THREAD, turnStart: {} } });
    expect(await follower.next()).toMatchObject({ type: "response", requestId: "write",
      resultType: "error", error: "denied" });
    follower.send({ type: "request", requestId: "other", method: "thread-owner-discovery",
      version: 1, params: { conversationId: "other-thread", hostId: "local" } });
    expect(await follower.next()).toMatchObject({ type: "response", requestId: "other",
      resultType: "error", error: "denied" });

    follower.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: "forged", params: { conversationId: THREAD, hostId: "local", following: true } });
    follower.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: "owner-assigned-client",
      params: { conversationId: "other-thread", hostId: "local", following: true } });
    follower.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: "owner-assigned-client", params: { conversationId: THREAD,
        hostId: "local", following: true, extra: "discard" } });
    await Bun.sleep(30);
    expect(ownerMessages).toHaveLength(2);
    expect(ownerMessages[1]).toEqual({ type: "broadcast", method: "thread-stream-following-changed",
      version: 1, sourceClientId: "owner-assigned-client",
      params: { conversationId: THREAD, hostId: "local", following: true } });

    ownerPeer?.send({ type: "client-discovery-request", requestId: "claim",
      request: { method: "thread-owner-discovery", params: { conversationId: THREAD } } });
    await Bun.sleep(30);
    expect(ownerMessages.at(-1)).toEqual({ type: "client-discovery-response", requestId: "claim",
      response: { canHandle: false } });
    ownerPeer?.send({ type: "broadcast", method: "thread-stream-state-changed",
      params: { conversationId: "other-thread", hostId: "local", change: { type: "snapshot" } } });
    ownerPeer?.send({ type: "broadcast", method: "thread-stream-state-changed",
      params: { conversationId: THREAD, hostId: "local", change: { type: "snapshot", marker: "allowed" } } });
    expect(await follower.next()).toMatchObject({ params: { conversationId: THREAD,
      change: { marker: "allowed" } } });
    await expect(follower.next(100)).rejects.toThrow("Timed out");
    expect(ownerMessages.some(message => message.method === "thread-follower-start-turn")).toBe(false);
  } finally {
    client?.destroy();
    await gate?.close();
    await new Promise<void>(resolveClose => owner.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
