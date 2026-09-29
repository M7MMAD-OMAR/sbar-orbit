import { Database } from "bun:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { cp, chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, join, relative } from "node:path";
import { startCodexReadOnlyGate } from "../src/codex-authority-gate";
import { createDisposablePaginatedReader } from "./codex-paginated-bwrap-bridge";

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown>;
  result?: Record<string, unknown>; error?: Record<string, unknown> };

class Probe {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private ready = false;
  private pending = new Map<number, (message: Rpc) => void>();
  private sequence = 0;
  readonly opened: Promise<void>;

  constructor(path: string) {
    this.socket = createConnection({ path });
    this.opened = new Promise((resolveOpen, rejectOpen) => {
      this.socket.once("connect", () => {
        const key = randomBytes(16).toString("base64");
        this.socket.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.socket.once("error", rejectOpen);
      this.socket.on("data", chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.ready) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          if (!this.buffer.subarray(0, end).toString("ascii").startsWith("HTTP/1.1 101"))
            return rejectOpen(new Error("Gate WebSocket upgrade failed"));
          this.buffer = this.buffer.subarray(end + 4);
          this.ready = true;
          resolveOpen();
        }
        for (;;) {
          if (this.buffer.length < 2) return;
          const first = this.buffer[0];
          const second = this.buffer[1];
          if (first === undefined || second === undefined || (first & 15) !== 1 || (second & 128) !== 0)
            return rejectOpen(new Error("Unexpected WebSocket frame"));
          let size = second & 127;
          let header = 2;
          if (size === 126) {
            if (this.buffer.length < 4) return;
            size = this.buffer.readUInt16BE(2);
            header = 4;
          } else if (size === 127) {
            if (this.buffer.length < 10) return;
            size = Number(this.buffer.readBigUInt64BE(2));
            header = 10;
          }
          if (this.buffer.length < header + size) return;
          const message = JSON.parse(this.buffer.subarray(header, header + size).toString("utf8")) as Rpc;
          this.buffer = this.buffer.subarray(header + size);
          if (typeof message.id !== "number") continue;
          const resolvePage = this.pending.get(message.id);
          if (!resolvePage) continue;
          this.pending.delete(message.id);
          resolvePage(message);
        }
      });
    });
  }

  async call(method: string, params: Record<string, unknown>) {
    await this.opened;
    const id = ++this.sequence;
    const response = new Promise<Rpc>((resolvePage, rejectPage) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectPage(new Error("Gate response timed out")); }, 6500);
      this.pending.set(id, message => { clearTimeout(timer); resolvePage(message); });
    });
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = randomBytes(4);
    const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
      : payload.length <= 65535 ? Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255])
        : Buffer.from([0x81, 0xff, 0, 0, 0, 0,
          (payload.length / 0x1000000) & 255, (payload.length >> 16) & 255,
          (payload.length >> 8) & 255, payload.length & 255]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
    this.socket.write(Buffer.concat([header, mask, masked]));
    return await response;
  }

  close() { this.socket.destroy(); }
}

async function fixtureSnapshot(root: string) {
  const files: string[] = [];
  const walk = async (path: string) => {
    for (const entry of await readdir(path)) {
      const full = join(path, entry);
      const info = await lstat(full);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) files.push(relative(root, full));
    }
  };
  await walk(root);
  files.sort();
  return Object.fromEntries(await Promise.all(files.map(async name => {
    const path = join(root, name);
    const info = await lstat(path);
    return [name, { sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      size: info.size, mtimeMs: info.mtimeMs }] as const;
  })));
}

async function main() {
  const [fakeRoot, binary] = process.argv.slice(2);
  if (!fakeRoot || !binary || !fakeRoot.startsWith("/var/tmp/codex-private-smoke-w/"))
    throw new Error("Pass an explicit retained fake account root and test helper binary");
  const root = await mkdtemp("/tmp/orbit-paginated-gate-bridge-");
  const fixture = join(root, "fixture");
  await Bun.write(join(root, "marker"), "disposable");
  await cp(join(fakeRoot, "sessions"), join(fixture, "sessions"), { recursive: true });
  for (const base of ["state_5.sqlite", "thread_history_1.sqlite"]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const input = join(fakeRoot, base + suffix);
      if (await Bun.file(input).exists()) await cp(input, join(fixture, base + suffix));
    }
  }
  const stateDb = new Database(join(fixture, "state_5.sqlite"));
  const row = stateDb.query("SELECT id, rollout_path FROM threads WHERE history_mode = 'paginated' LIMIT 1")
    .get() as { id: string; rollout_path: string } | null;
  if (!row) throw new Error("Retained fake fixture has no paginated thread");
  const suffix = relative(join(fakeRoot, "sessions"), row.rollout_path);
  if (suffix.startsWith("..") || basename(row.rollout_path) !== basename(suffix))
    throw new Error("Retained fake rollout is outside its sessions directory");
  stateDb.query("UPDATE threads SET rollout_path = ? WHERE id = ?")
    .run(join("/fixture/sessions", suffix), row.id);
  stateDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  stateDb.exec("PRAGMA journal_mode=DELETE");
  stateDb.close();
  const historyDb = new Database(join(fixture, "thread_history_1.sqlite"));
  historyDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  historyDb.exec("PRAGMA journal_mode=DELETE");
  historyDb.close();
  const before = await fixtureSnapshot(fixture);

  const ownerPath = join(root, "owner.sock");
  const statePath = `${ownerPath}.state`;
  const ownerMethods: string[] = [];
  const owner = Bun.serve({ unix: ownerPath,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("WebSocket required", { status: 400 }); },
    websocket: { message(socket, input) {
      const request = JSON.parse(String(input)) as Rpc;
      ownerMethods.push(request.method ?? "unknown");
      if (request.id === undefined) return;
      const result = request.method === "thread/read" ? { thread: { id: row.id, historyMode: "paginated" } }
        : { data: [] };
      socket.send(JSON.stringify({ id: request.id, result }));
    } },
  });
  const state = createServer(socket => socket.on("data", () => socket.end()));
  await new Promise<void>(resolveListen => state.listen(statePath, resolveListen));
  await chmod(ownerPath, 0o600);
  await chmod(statePath, 0o600);
  const socketIdentity = async (path: string) => {
    const info = await lstat(path, { bigint: true });
    return { device: String(info.dev), inode: String(info.ino) };
  };
  let gate: Awaited<ReturnType<typeof startCodexReadOnlyGate>> | undefined;
  let probe: Probe | undefined;
  try {
    gate = await startCodexReadOnlyGate(root, ownerPath, statePath, {
      ownerIdentity: await socketIdentity(ownerPath), stateIdentity: await socketIdentity(statePath),
      allowLegacyThreadRead: true, allowPaginatedThreadPages: true,
      readPaginatedThreadPage: await createDisposablePaginatedReader(binary, fixture),
    });
    probe = new Probe(gate.socketPath);
    const metadata = await probe.call("thread/read", { threadId: row.id, includeTurns: false, readOnly: true });
    const first = await probe.call("thread/turns/list", { threadId: row.id, limit: 5, cursor: null,
      sortDirection: "asc", itemsView: "full", readOnly: true });
    const item = await probe.call("thread/items/list", { threadId: row.id, limit: 5,
      sortDirection: "asc", readOnly: true });
    const denied = await probe.call("turn/start", { threadId: row.id, input: [] });
    const after = await fixtureSnapshot(fixture);
    const pageText = JSON.stringify(first.result);
    const result = {
      metadataMode: (metadata.result?.thread as { historyMode?: string } | undefined)?.historyMode ?? null,
      turnCount: Array.isArray(first.result?.data) ? first.result.data.length : null,
      itemCount: Array.isArray(item.result?.data) ? item.result.data.length : null,
      userTextPresent: pageText.includes("Private fixture conversation"),
      assistantTextPresent: pageText.includes("Orbit completed fixture answer"),
      fullView: Array.isArray(first.result?.data) && first.result.data.every((turn: unknown) =>
        typeof turn === "object" && turn !== null && (turn as { itemsView?: string }).itemsView === "full"),
      pageError: first.error ?? null, itemError: item.error ?? null,
      deniedTurn: denied.error?.code === -32601,
      ownerMethods, ownerSawPage: ownerMethods.some(method => method === "thread/turns/list" || method === "thread/items/list"),
      fixtureFilesUnchanged: JSON.stringify(before) === JSON.stringify(after),
      filesBefore: before, filesAfter: after,
      temporaryFixtureOnly: true,
    };
    console.log(JSON.stringify(result));
    if (result.metadataMode !== "paginated" || result.turnCount !== 1 || result.itemCount !== 2 ||
        !result.userTextPresent || !result.assistantTextPresent || !result.fullView ||
        !result.deniedTurn || result.ownerSawPage || !result.fixtureFilesUnchanged)
      throw new Error("Disposable paginated gate bridge assertion failed");
  } finally {
    probe?.close();
    await gate?.close();
    owner.stop(true);
    await new Promise<void>(resolveClose => state.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}

await main();
