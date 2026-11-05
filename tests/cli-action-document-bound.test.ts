import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { OrbitError } from "../src/errors";

const maximum = 1_048_576;
const linux = process.platform === "linux" ? test : test.skip;
async function bounded<T>(promise: Promise<T>, milliseconds = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error("Owned action fixture settlement unknown; resources retained")), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function preserving(work: () => Promise<void>, cleanup: () => Promise<void>) {
  let failed = false, primary: unknown;
  try { await work(); } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (error) { if (failed) throw new AggregateError([primary, error], "Owned action fixture and cleanup failed"); throw error; }
  if (failed) throw primary;
}
async function cappedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), bytes = new Uint8Array(16384); let used = 0, ended = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { ended = true; return new TextDecoder().decode(bytes.subarray(0, used)); }
      if (part.value.byteLength > bytes.byteLength - used) throw new Error("Owned CLI output exceeded fixture bound");
      bytes.set(part.value, used); used += part.value.byteLength;
    }
  } finally {
    if (!ended) { try { void reader.cancel().catch(() => {}); } catch { /* Unknown output is retained in tracking. */ } }
    try { reader.releaseLock(); } catch { /* No false EOF claim. */ }
  }
}
async function fixture() {
  const root = await mkdtemp("/tmp/oad-"), socket = join(root, "b"), requests: { method: string; action: unknown }[] = [];
  const exits = new Set<Promise<number>>(), reads = new Set<Promise<unknown>>(); let callbacks = 0;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const close = async () => {
    if (exits.size || reads.size || callbacks) throw new Error("Owned input/child/callback unknown; server and root retained");
    await server?.stop(true); await rm(root, { recursive: true, force: true });
  };
  try {
    server = Bun.serve({ unix: socket, async fetch(request) {
      callbacks++;
      try {
        const body = await request.json() as { method: string; params: { action?: unknown } };
        requests.push({ method: body.method, action: body.params.action });
        return Response.json({ ok: true, result: { received: body.params.action } });
      } finally { callbacks--; }
    } });
    const run = async (chunks: readonly Uint8Array[], debug = false, withholdEofUntilExit = false) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "act", "owned-session", "-"], { cwd: root,
        stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root,
          ORBIT_SOCKET: socket, ORBIT_USAGE_DIR: join(root, "u"), ORBIT_CONVERSATION_ID: "owned-action-bound",
          XDG_STATE_HOME: join(root, "s"), XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_CACHE_HOME: join(root, "k"),
          ...(debug ? { ORBIT_DEBUG: "1" } : {}),
        } });
      let exitObserved = false, endedBeforeExit = false, inputEndCalled = false, acceptedBytes = 0;
      let exitWithInputOpen: boolean | undefined;
      const exited = child.exited; exits.add(exited); void exited.then(() => {
        exitWithInputOpen = !inputEndCalled; exitObserved = true; exits.delete(exited);
      }, () => {});
      const feeding = (async () => {
        let failure: string | undefined, successfulFeed = false;
        try {
          for (const chunk of chunks) for (let offset = 0; offset < chunk.byteLength; offset += 16384) {
            const slice = chunk.subarray(offset, Math.min(offset + 16384, chunk.byteLength));
            const accepted = await child.stdin.write(slice);
            if (accepted !== slice.byteLength) throw new Error("Owned stdin short write; no suffix replay");
            acceptedBytes += accepted; await child.stdin.flush();
          }
          successfulFeed = true;
          if (withholdEofUntilExit) {
            try { await bounded(exited, 1000); }
            catch { failure = "EXIT_BEFORE_EOF_UNCONFIRMED"; }
          }
        } catch (error) {
          const code: unknown = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
          failure = typeof code === "string" ? code : "INPUT_WRITE_FAILED";
        } finally {
          // Every harness failure produces EOF immediately, never awaits the child
          // while it may still be waiting for our input. No signal or producer-stop claim.
          endedBeforeExit = !exitObserved; inputEndCalled = true;
          try { await child.stdin.end(); } catch { failure ??= "INPUT_END_UNCONFIRMED"; }
        }
        return failure ?? (successfulFeed ? undefined : "INPUT_WRITE_FAILED");
      })();
      const track = <T>(promise: Promise<T>): Promise<T> => {
        reads.add(promise); void promise.then(() => { reads.delete(promise); }, () => {});
        return promise; // Rejection is not EOF/owned-input completion proof; retain conservatively.
      };
      const completed = Promise.all([track(cappedText(child.stdout)), track(cappedText(child.stderr)), exited, track(feeding)]);
      const [out, err, code, feedFailure] = await bounded(completed);
      return { out, err, code, feedFailure, endedBeforeExit, exitWithInputOpen, acceptedBytes, success: out.trim() ? JSON.parse(out) as { ok: boolean; result: { received: unknown } } : undefined,
        failure: err.trim() ? JSON.parse(err) as { error: { code: string; message: string } } : undefined };
    };
    return { root, requests, run, close };
  } catch (primary) { try { await close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "Owned action setup and cleanup failed"); } throw primary; }
}

linux("normal stdin JSON preserves accepted semantics before its sole fake broker request", async () => {
  const f = await fixture();
  await preserving(async () => {
    const document = { type: "state", note: "ordinary" };
    const value = await f.run([Buffer.from(JSON.stringify(document))]);
    expect(value.code).toBe(0); expect(value.err).toBe(""); expect(value.feedFailure).toBeUndefined();
    expect(value.success).toEqual({ ok: true, result: { received: document } });
    expect(f.requests).toEqual([{ method: "session.act", action: document }]);
  }, f.close);
});

linux("exact 1MiB raw stdin bytes with fragmented multibyte text are accepted", async () => {
  const f = await fixture();
  await preserving(async () => {
    const document = { type: "state", note: "é😀" }, prefix = Buffer.from(JSON.stringify(document));
    const input = Buffer.concat([prefix, Buffer.alloc(maximum - prefix.length, 32)]), split = prefix.indexOf(Buffer.from("é")) + 1;
    expect(input.length).toBe(maximum);
    const value = await f.run([input.subarray(0, split), input.subarray(split)]);
    expect(value.code).toBe(0); expect(value.err).toBe(""); expect(value.feedFailure).toBeUndefined();
    expect(value.success?.result.received).toEqual(document); expect(f.requests).toHaveLength(1);
  }, f.close);
});

linux("one byte past stdin limit refuses before RPC and never echoes document content even in debug", async () => {
  const f = await fixture();
  await preserving(async () => {
    const prefix = Buffer.from(JSON.stringify({ type: "state", secret: "OWNED-PRIVATE-OVERSIZE" }));
    const input = Buffer.concat([prefix, Buffer.alloc(maximum + 1 - prefix.length, 32)]);
    expect(input.length).toBe(maximum + 1);
    const value = await f.run([input], true, true);
    expect(value.feedFailure).toBeUndefined(); // EPIPE or any short/failed write never satisfies the proof.
    expect(value.acceptedBytes).toBe(maximum + 1); // Awaited API acceptance, not receiver/drain provenance.
    expect(value.exitWithInputOpen).toBe(true); // Positive observation in actual child.exited handler.
    expect(value.endedBeforeExit).toBe(false);
    expect(value.code).toBe(1); expect(value.out).toBe(""); expect(value.failure?.error.code).toBe("INVALID_REQUEST");
    expect(value.failure?.error.message).toContain("exceeds 1 MiB"); expect(value.err).not.toContain("OWNED-PRIVATE-OVERSIZE");
    expect(f.requests).toEqual([]);
  }, f.close);
});

linux("stdin replacement and UTF-8 BOM behavior remain compatible with Response.text", async () => {
  const f = await fixture();
  await preserving(async () => {
    const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"type":"state","note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    const expected = JSON.parse(await new Response(input).text()) as unknown;
    const value = await f.run([input]); expect(value.code).toBe(0); expect(value.err).toBe("");
    expect(value.success?.result.received).toEqual(expected); expect(f.requests).toHaveLength(1);
  }, f.close);
});

async function isolatedReader(reader?: { read(): Promise<unknown>; cancel(): Promise<void>; releaseLock(): void }) {
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function readActionStdin("), end = source.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end + 2) + "\nglobalThis.__ReadStdin = readActionStdin;");
  const context: Record<string, unknown> = { OrbitError, Uint8Array, TextDecoder, Bun: { stdin: { stream(...args: unknown[]) { expect(args).toEqual([]); return { getReader: () => { if (!reader) throw new Error("OWNED-PRIVATE-SETUP-CAUSE"); return reader; } }; } } } };
  runInNewContext(code, context);
  return context.__ReadStdin as () => Promise<string>;
}

test("actual stdin setup failure is fixed redacted INVALID_REQUEST before owning a reader", async () => {
  const read = await isolatedReader();
  const error: unknown = await read().catch(error => error);
  expect(error).toBeInstanceOf(OrbitError);
  expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "Could not read action document from standard input" });
  expect(String(error)).not.toContain("OWNED-PRIVATE-SETUP-CAUSE");
});

test("actual stdin helper rejects an oversized runtime chunk before retention and never awaits pending cancel", async () => {
  let reads = 0, cancels = 0, releases = 0;
  const read = await isolatedReader({ read: async () => { reads++; return { done: false, value: new Uint8Array(maximum + 1) }; },
    cancel: () => { cancels++; return new Promise<void>(() => {}); }, releaseLock: () => { releases++; } });
  const error: unknown = await bounded(read().catch(error => error), 500);
  expect(error).toBeInstanceOf(OrbitError); expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "The action document from standard input exceeds 1 MiB." });
  expect(reads).toBe(1); expect(cancels).toBe(1); expect(releases).toBe(1);
});

test("actual stdin helper reports read failures without cause text and releases its owned reader", async () => {
  let cancels = 0, releases = 0;
  const read = await isolatedReader({ read: async () => { throw new Error("OWNED-PRIVATE-READ-CAUSE"); }, cancel: async () => { cancels++; }, releaseLock: () => { releases++; } });
  const error: unknown = await read().catch(error => error);
  expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "Could not read action document from standard input" });
  expect(String(error)).not.toContain("OWNED-PRIVATE-READ-CAUSE"); expect(cancels).toBe(1); expect(releases).toBe(1);
});

for (const kind of ["private", "oversize-lookalike"] as const) test("reader OrbitError is redacted by identity, including actual debug formatter: " + kind, async () => {
  const malicious = new OrbitError("INVALID_REQUEST", kind === "private" ? "OWNED-PRIVATE-READER-MESSAGE" : "The action document from standard input exceeds 1 MiB.", "OWNED-PRIVATE-READER-DIAGNOSTIC");
  malicious.stack = "OWNED-PRIVATE-READER-STACK";
  let cancels = 0, releases = 0;
  const read = await isolatedReader({ read: async () => { throw malicious; }, cancel: async () => { cancels++; }, releaseLock: () => { releases++; } });
  const failure: unknown = await read().catch(error => error);
  expect(failure).toBeInstanceOf(OrbitError); expect(failure).not.toBe(malicious);
  expect(failure).toMatchObject({ code: "INVALID_REQUEST", message: "Could not read action document from standard input" });
  expect(cancels).toBe(1); expect(releases).toBe(1);
  // Run the real CLI outer error formatter, not a copied payload approximation.
  // In-process source execution only, no CLI process, globals mutation or native I/O.
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const start = source.lastIndexOf("} catch (error) {"); expect(start).toBeGreaterThan(0);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync("try { throw globalThis.__Failure; " + source.slice(start));
  const outputs: string[] = [], processState = { env: { ORBIT_DEBUG: "1" }, exitCode: 0 };
  runInNewContext(code, { OrbitError, Error, __Failure: failure, process: processState, console: { error(value: string) { outputs.push(value); } } });
  expect(processState.exitCode).toBe(1); expect(outputs).toHaveLength(1);
  const payload = JSON.parse(outputs[0]!) as { error: { code: string; message: string; diagnosticId?: string; stack?: string[] } };
  expect(payload.error.code).toBe("INVALID_REQUEST"); expect(payload.error.message).toBe("Could not read action document from standard input");
  expect(payload.error.diagnosticId).toBeUndefined(); expect(Array.isArray(payload.error.stack)).toBe(true);
  expect(outputs[0]).not.toContain("OWNED-PRIVATE-READER"); expect(outputs[0]).not.toContain("exceeds 1 MiB");
});

test("actual stdin helper accepts empty chunks between bytes without changing replacement decoding", async () => {
  const data = Buffer.from('{"note":"é"}'), split = data.indexOf(Buffer.from("é")) + 1;
  const chunks = [new Uint8Array(), new Uint8Array(data.subarray(0, split)), new Uint8Array(), new Uint8Array(data.subarray(split))];
  let index = 0, cancels = 0, releases = 0;
  const read = await isolatedReader({ read: async () => index < chunks.length ? { done: false, value: chunks[index++]! } : { done: true },
    cancel: async () => { cancels++; }, releaseLock: () => { releases++; } });
  expect(await read()).toBe(await new Response(data).text()); expect(cancels).toBe(0); expect(releases).toBe(1);
});
