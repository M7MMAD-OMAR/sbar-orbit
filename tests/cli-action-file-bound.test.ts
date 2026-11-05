import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { OrbitError } from "../src/errors";

const maximum = 1_048_576;
const linux = process.platform === "linux" ? test : test.skip;
async function bounded<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error("Owned file fixture settlement unknown; resources retained")), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function preserving(work: () => Promise<void>, cleanup: () => Promise<void>) {
  let failed = false, primary: unknown;
  try { await work(); } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (error) { if (failed) throw new AggregateError([primary, error], "Owned file fixture and cleanup failed"); throw error; }
  if (failed) throw primary;
}
async function fixture() {
  const root = await mkdtemp("/tmp/oaf-"), socket = join(root, "b");
  const calls: unknown[] = [], exits = new Set<Promise<number>>(), io = new Set<Promise<unknown>>();
  let callbacks = 0, server: ReturnType<typeof Bun.serve> | undefined;
  const close = async () => {
    if (exits.size || io.size || callbacks) throw new Error("Owned file child/callback unknown; root retained");
    await server?.stop(true); await rm(root, { recursive: true, force: true });
  };
  try {
    server = Bun.serve({ unix: socket, async fetch(request) {
      callbacks++;
      try {
        const body = await request.json() as { method: string; params: { action: unknown } };
        calls.push({ method: body.method, action: body.params.action });
        return Response.json({ ok: true, result: { received: body.params.action } });
      } finally { callbacks--; }
    } });
    const run = async (path: string, debug = false) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "act", "owned-session", "@" + path], { cwd: root,
        stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root,
          ORBIT_SOCKET: socket, ORBIT_USAGE_DIR: join(root, "u"), ORBIT_CONVERSATION_ID: "owned-file-bound",
          XDG_STATE_HOME: join(root, "s"), XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_CACHE_HOME: join(root, "k"),
          ...(debug ? { ORBIT_DEBUG: "1" } : {}),
        } });
      const exited = child.exited; exits.add(exited); void exited.then(() => { exits.delete(exited); }, () => {});
      const completed = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), exited]);
      io.add(completed); void completed.then(() => { io.delete(completed); }, () => {});
      const [out, err, code] = await bounded(completed);
      return { out, err, code, result: out.trim() ? (JSON.parse(out) as { result: { received: unknown } }).result : undefined,
        error: err.trim() ? (JSON.parse(err) as { error: { code: string; message: string } }).error : undefined };
    };
    return { root, calls, run, close };
  } catch (primary) { try { await close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "Owned file setup and cleanup failed"); } throw primary; }
}

linux("POSIX actual CLI reads owned regular files and preserves regular symlink semantics", async () => {
  const f = await fixture();
  await preserving(async () => {
    const path = join(f.root, "a.json"), link = join(f.root, "link.json"), value = { type: "state", note: "é" };
    await writeFile(path, JSON.stringify(value)); await symlink(path, link);
    for (const source of [path, link]) {
      const result = await f.run(source); expect(result.code).toBe(0); expect(result.err).toBe(""); expect(result.result?.received).toEqual(value);
    }
    expect(f.calls).toEqual([{ method: "session.act", action: value }, { method: "session.act", action: value }]);
  }, f.close);
});

linux("POSIX actual CLI accepts exactly 1MiB bytes and refuses a larger regular file before RPC", async () => {
  const f = await fixture();
  await preserving(async () => {
    const path = join(f.root, "bounded.json"), value = { type: "state", note: "é" }, prefix = Buffer.from(JSON.stringify(value));
    await writeFile(path, Buffer.concat([prefix, Buffer.alloc(maximum - prefix.length, 32)]));
    const accepted = await f.run(path); expect(accepted.code).toBe(0); expect(accepted.result?.received).toEqual(value);
    await writeFile(path, Buffer.concat([prefix, Buffer.alloc(maximum + 1 - prefix.length, 32)]));
    const refused = await f.run(path); expect(refused.code).toBe(1); expect(refused.out).toBe(""); expect(refused.error?.code).toBe("INVALID_REQUEST");
    expect(refused.error?.message).toContain("1 MiB"); expect(refused.error?.message).toContain(`${maximum + 1} bytes`);
    expect(refused.error?.message).toContain("mistyped path"); expect(f.calls).toHaveLength(1);
  }, f.close);
});

linux("POSIX actual CLI keeps malformed-file errors content-free and names the selected path", async () => {
  const f = await fixture();
  await preserving(async () => {
    const path = join(f.root, "private.env"); await writeFile(path, "OWNED-PRIVATE-FILE-CONTENT=secret");
    const result = await f.run(path, true); expect(result.code).toBe(1); expect(result.out).toBe("");
    expect(result.error?.code).toBe("INVALID_REQUEST"); expect(result.error?.message).toContain(path); expect(result.error?.message).toContain("is not JSON");
    expect(result.err).not.toContain("OWNED-PRIVATE-FILE-CONTENT"); expect(f.calls).toEqual([]);
  }, f.close);
});

type Shim = { bytes: Uint8Array; advisoryRegular?: boolean; openedRegular?: boolean; initialSize?: number; nonblocking?: number; partial?: number; failRead?: boolean; failClose?: boolean };
async function isolated(options: Shim) {
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8"), start = source.indexOf("async function readActionFile("), end = source.indexOf("\n}", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const fragment = source.slice(start, end + 2).replace('await import("node:fs")', "globalThis.__FS").replace('await import("node:fs/promises")', "globalThis.__FSP");
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(fragment + "\nglobalThis.__ReadFile = readActionFile;");
  const state = { advisory: 0, opens: 0, fstats: 0, closes: 0, flags: 0, bytes: 0, reads: [] as { offset: number; length: number; position: number }[] };
  const handle = { stat: async () => { state.fstats++; return { isFile: () => options.openedRegular !== false, size: options.initialSize ?? options.bytes.length }; },
    read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
      state.reads.push({ offset, length, position });
      if (options.failRead) throw new OrbitError("PRIVATE", "OWNED-PRIVATE-READ-CAUSE");
      const count = Math.max(0, Math.min(length, options.partial ?? length, options.bytes.length - position));
      buffer.set(options.bytes.subarray(position, position + count), offset); state.bytes += count; return { bytesRead: count };
    }, close: async () => { state.closes++; if (options.failClose) throw new OrbitError("PRIVATE", "OWNED-PRIVATE-CLOSE-CAUSE"); } };
  const context: Record<string, unknown> = { OrbitError, Uint8Array, TextDecoder,
    __FS: { constants: { O_RDONLY: 0, O_NONBLOCK: options.nonblocking ?? 2048 }, statSync() { state.advisory++; return { isFile: () => options.advisoryRegular !== false, size: options.initialSize ?? options.bytes.length }; } },
    __FSP: { async open(_path: string, flags: number) { state.opens++; state.flags = flags; return handle; } } };
  runInNewContext(compiled, context);
  return { read: context.__ReadFile as (path: string) => Promise<string>, state };
}

test("actual POSIX file helper reads partial chunks from only the pinned nonblocking handle and closes once", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"type":"state","note":"é"}')]);
  const f = await isolated({ bytes, partial: 3 });
  expect(await f.read("owned.json")).toBe(await new Response(bytes).text());
  expect(f.state.advisory).toBe(1); expect(f.state.opens).toBe(1); expect(f.state.fstats).toBe(1); expect(f.state.closes).toBe(1);
  expect(f.state.flags & 2048).toBe(2048); expect(f.state.reads.length).toBeGreaterThan(1);
  expect(f.state.reads.every(read => read.position === read.offset && read.length <= 65536 && read.length <= maximum + 1 - read.position)).toBe(true);
});

test("actual POSIX helper caps a synthetic growing regular file at MAX+1 despite a small fstat", async () => {
  const f = await isolated({ bytes: new Uint8Array(maximum + 1), initialSize: 2 });
  await expect(f.read("growing.json")).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "The action document at growing.json exceeds 1 MiB." });
  expect(f.state.bytes).toBe(maximum + 1); expect(f.state.reads.at(-1)?.length).toBe(1); expect(f.state.closes).toBe(1);
});

test("actual helper rejects ordinary special paths before open and swapped special descriptors before read", async () => {
  const advisory = await isolated({ bytes: new Uint8Array(), advisoryRegular: false });
  await expect(advisory.read("owned-special")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(advisory.state.opens).toBe(0); expect(advisory.state.reads).toEqual([]);
  const changed = await isolated({ bytes: new Uint8Array(), openedRegular: false });
  await expect(changed.read("owned-swapped")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(changed.state.opens).toBe(1); expect(changed.state.reads).toEqual([]); expect(changed.state.closes).toBe(1);
  // Mock descriptor only. No host device, FIFO creation, process helper or hostile-open safety proof.
});

test("actual helper refuses unsupported nonblocking flags and redacts read/close failures without retry", async () => {
  const unavailable = await isolated({ bytes: new Uint8Array(), nonblocking: 0 });
  await expect(unavailable.read("owned.json")).rejects.toMatchObject({ code: "INVALID_REQUEST" }); expect(unavailable.state.opens).toBe(0);
  for (const failure of ["read", "close", "both"] as const) {
    const f = await isolated({ bytes: Buffer.from("{}"), failRead: failure !== "close", failClose: failure !== "read" });
    const error: unknown = await f.read("owned.json").catch(error => error);
    expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "Could not read action document at owned.json" });
    expect(String(error)).not.toContain("OWNED-PRIVATE"); expect(f.state.closes).toBe(1);
  }
});
