import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_BUFFER = MAX_FRAME * 2;

type Message = Record<string, unknown>;
type SocketIdentity = { device: bigint; inode: bigint };

function record(value: unknown): Message | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Message : null;
}

function frame(message: Message): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length === 0 || body.length > MAX_FRAME) throw new Error("Codex IPC frame is too large");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}

function forward(destination: Socket, source: Socket, content: Buffer) {
  if (!destination.writable || destination.writableLength + content.length > MAX_BUFFER) {
    source.destroy();
    destination.destroy();
    return;
  }
  if (!destination.write(content)) {
    source.pause();
    destination.once("drain", () => source.resume());
  }
}

function readFrames(socket: Socket, onMessage: (message: Message, content: Buffer) => void) {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    if (pending.length + chunk.length > MAX_BUFFER) {
      socket.destroy();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (length < 1 || length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      if (pending.length < length + 4) return;
      const content = pending.subarray(0, length + 4);
      pending = pending.subarray(length + 4);
      let message: Message | null;
      try { message = record(JSON.parse(content.subarray(4).toString("utf8"))); }
      catch { message = null; }
      if (!message) {
        socket.destroy();
        return;
      }
      try { onMessage(message, content); }
      catch { socket.destroy(); }
      if (socket.destroyed) return;
    }
  });
}

async function socketIdentity(path: string): Promise<SocketIdentity> {
  const parent = await lstat(dirname(path));
  const entry = await lstat(path, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() ||
      (parent.mode & 0o077) !== 0 || await realpath(dirname(path)) !== dirname(path) ||
      !entry.isSocket() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid?.() ?? -1) ||
      (entry.mode & 0o077n) !== 0n || entry.nlink !== 1n || await realpath(path) !== path)
    throw new Error("Codex IPC owner socket is not private");
  return { device: entry.dev, inode: entry.ino };
}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 || await realpath(path) !== path)
    throw new Error("Codex IPC gate directory is not private");
}

export async function startCodexScopedIpcGate(privateHome: string, ownerSocketPath: string,
                                              threadId: string,
                                              auditDenied?: (message: Message) => void) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId))
    throw new Error("Codex IPC gate needs one thread ID");
  const owner = await socketIdentity(ownerSocketPath);
  await privateDirectory(privateHome);
  const codexDirectory = join(privateHome, ".codex");
  await mkdir(codexDirectory, { recursive: true, mode: 0o700 });
  await privateDirectory(codexDirectory);
  const directory = join(privateHome, ".codex", "ipc");
  await mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const socketPath = join(directory, "ipc.sock");
  const connections = new Set<Socket>();
  const counts = { connections: 0, followingForwarded: 0, snapshotsForwarded: 0,
    clientRequestsDenied: 0 };
  const server = createServer(downstream => {
    counts.connections += 1;
    connections.add(downstream);
    let upstream: Socket | undefined;
    let handleClientMessage: ((message: Message) => void) | undefined;
    const earlyMessages: Message[] = [];
    let earlyBytes = 0;
    readFrames(downstream, (message, content) => {
      if (handleClientMessage) handleClientMessage(message);
      else {
        earlyBytes += content.length;
        if (earlyBytes > MAX_BUFFER) downstream.destroy();
        else earlyMessages.push(message);
      }
    });
    void (async () => {
      const current = await socketIdentity(ownerSocketPath);
      if (current.device !== owner.device || current.inode !== owner.inode) throw new Error("Codex IPC owner changed");
      const ownerConnection = createConnection({ path: ownerSocketPath });
      upstream = ownerConnection;
      connections.add(ownerConnection);
      await new Promise<void>((resolveConnect, rejectConnect) => {
        ownerConnection.once("connect", resolveConnect);
        ownerConnection.once("error", rejectConnect);
        ownerConnection.setTimeout(2000, () => rejectConnect(new Error("Codex IPC owner did not respond")));
      });
      ownerConnection.setTimeout(0);
      const after = await socketIdentity(ownerSocketPath);
      if (after.device !== owner.device || after.inode !== owner.inode) throw new Error("Codex IPC owner changed");
      let clientId: string | null = null;
      let initializePending = false;
      const closeBoth = () => { downstream.destroy(); ownerConnection.destroy(); };
      downstream.on("close", () => { connections.delete(downstream); ownerConnection.destroy(); });
      ownerConnection.on("close", () => { connections.delete(ownerConnection); downstream.destroy(); });
      downstream.on("error", closeBoth);
      ownerConnection.on("error", closeBoth);
      handleClientMessage = (message) => {
        const kind = message.type;
        const method = message.method;
        const params = record(message.params);
        if (kind === "request" && method === "initialize" && clientId === null &&
            !initializePending && typeof message.requestId === "string" &&
            message.requestId.length <= 128 && typeof params?.clientType === "string" &&
            params.clientType.length <= 128) {
          initializePending = true;
          forward(ownerConnection, downstream, frame({ type: "request", requestId: message.requestId,
            method: "initialize", version: 1, params: { clientType: params.clientType } }));
          return;
        }
        if (kind === "broadcast" && method === "thread-stream-following-changed" &&
            clientId !== null && message.sourceClientId === clientId &&
            message.targetClientIds == null && params?.conversationId === threadId &&
            params.hostId === "local" && typeof params.following === "boolean") {
          counts.followingForwarded += 1;
          forward(ownerConnection, downstream, frame({ type: "broadcast", sourceClientId: clientId,
            method, version: 1, params: { conversationId: threadId, hostId: "local",
              following: params.following } }));
          return;
        }
        if (kind === "request" && typeof message.requestId === "string") {
          counts.clientRequestsDenied += 1;
          try { auditDenied?.(message); }
          catch { /* Audit failure cannot change the IPC policy. */ }
          forward(downstream, ownerConnection, frame({ type: "response", requestId: message.requestId,
            method, resultType: "error", error: "denied" }));
        }
      };
      readFrames(upstream, (message, content) => {
        const kind = message.type;
        const method = message.method;
        const params = record(message.params);
        if (kind === "client-discovery-request" && typeof message.requestId === "string") {
          forward(ownerConnection, downstream, frame({ type: "client-discovery-response",
            requestId: message.requestId, response: { canHandle: false } }));
          return;
        }
        if (kind === "response" && method === "initialize" && initializePending) {
          const result = record(message.result);
          if (message.resultType !== "success" || typeof result?.clientId !== "string") {
            closeBoth();
            return;
          }
          clientId = result.clientId;
          initializePending = false;
          forward(downstream, ownerConnection, content);
          return;
        }
        if (kind === "broadcast" &&
            (method === "thread-stream-state-changed" || method === "thread-stream-following-changed") &&
            params?.conversationId === threadId && params.hostId === "local") {
          if (method === "thread-stream-state-changed" &&
              record(params.change)?.type === "snapshot") counts.snapshotsForwarded += 1;
          forward(downstream, ownerConnection, content);
        }
      });
      for (const early of earlyMessages) handleClientMessage(early);
      earlyMessages.length = 0;
    })().catch(() => {
      downstream.destroy();
      upstream?.destroy();
      connections.delete(downstream);
      if (upstream) connections.delete(upstream);
    });
  });
  server.maxConnections = 16;
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) server.close();
    await rm(socketPath, { force: true });
    throw error;
  }
  return { socketPath, stats: () => ({ ...counts }), async close() {
    for (const connection of connections) connection.destroy();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(socketPath, { force: true });
  } };
}
