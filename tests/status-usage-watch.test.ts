import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual watcher and an owned fake Unix endpoint, never startBroker/apps/signals.
const unixTest = process.platform === "linux" ? test : test.skip;
type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "orbit-watch-usage-"));
  const root = join(base, "usage"), socket = join(base, "broker.sock"), id = "owned-watcher-conversation";
  const preference = join(root, createHash("sha256").update(id).digest("hex") + ".json");
  const put = async (enabled: boolean) => {
    await writeFile(preference + ".next", JSON.stringify({ enabled }), { mode: 0o600 });
    await rename(preference + ".next", preference);
  };
  const requests: string[] = [];
  let route = async (method: string): Promise<Reply> => method === "session.list"
    ? { ok: true, result: [{ sessionId: "owned-session", state: "running", backend: "native",
      agentName: "fixture", taskName: "fixture", activity: { state: "working" } }] }
    : { ok: true, result: { title: "private-status-fixture", location: "owned", tabs: [], pointer: null } };
  let server: ReturnType<typeof Bun.serve> | undefined;
  let setup = false;
  try {
    await mkdir(root, { mode: 0o700 });
    await put(true);
    server = Bun.serve({ unix: socket, async fetch(request) {
      const body = await request.json() as { method?: unknown };
      if (typeof body.method !== "string" || !["session.list", "session.presence"].includes(body.method))
        return Response.json({ ok: false, error: { code: "INVALID_REQUEST", message: "Owned fixture request refused" } });
      requests.push(body.method);
      return Response.json(await route(body.method));
    } });
    setup = true;
  } finally {
    if (!setup) {
      try { if (server) await server.stop(true); }
      finally { await rm(base, { recursive: true, force: true }); }
    }
  }
  const broker = server!;
  let used = false, childExited = false, streamsDrained = false;
  let detach: (() => void) | undefined;
  const run = async (options: { id?: string; onLine?: (line: string) => Promise<void> } = {}) => {
    if (used) throw new Error("Owned watcher fixture is single-use");
    used = true;
    const env: Record<string, string | undefined> = { ...process.env,
      ORBIT_CONVERSATION_ID: options.id ?? id, ORBIT_USAGE_DIR: root, ORBIT_SOCKET: socket,
      HOME: base, XDG_CONFIG_HOME: join(base, "config"), XDG_STATE_HOME: join(base, "state"),
      XDG_CACHE_HOME: join(base, "cache"), XDG_DATA_HOME: join(base, "data"), XDG_RUNTIME_DIR: base,
    };
    delete env.ORBIT_OWNER;
    delete env.ORBIT_DEBUG;
    // No timeout/AbortSignal/maxBuffer auto-kill and no numeric PID signals.
    let child;
    try {
      child = Bun.spawn({ cmd: [process.execPath, join(import.meta.dir, "../src/status.ts"), "--watch"],
        cwd: base, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      broker.unref();
      throw new Error("Owned watcher startup unconfirmed; fixture retained");
    }
    const stdout = child.stdout.getReader(), stderr = child.stderr.getReader();
    const exit = child.exited.then(code => { childExited = true; return code; });
    detach = () => {
      child.unref(); broker.unref();
      // Stop our owned reads only. EOF/closed pipes do not prove child stop.
      void stdout.cancel().catch(() => {});
      void stderr.cancel().catch(() => {});
    };
    const collect = async (reader: typeof stdout, emit: boolean) => {
      const decoder = new TextDecoder();
      let output = "", pending = "", bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 65536) throw new Error("Owned watcher output exceeded its fixture bound");
          const text = decoder.decode(next.value, { stream: true });
          output += text; pending += text;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (emit && options.onLine) await options.onLine(line);
          }
        }
        return output + decoder.decode();
      } finally { reader.releaseLock(); }
    };
    const out = collect(stdout, true), err = collect(stderr, false);
    const drained = Promise.allSettled([out, err]).then(() => { streamsDrained = true; });
    const complete = Promise.all([out, err, exit]).then(([out, err, code]) => ({ out, err, code }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owned watcher timed out; child stop unconfirmed, fixture retained")), 8000);
    });
    try {
      const result = await Promise.race([complete, expired]);
      await drained;
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!childExited || !streamsDrained) detach();
    }
  };
  return { base, root, socket, id, preference, put, requests, run,
    setRoute: (next: typeof route) => { route = next; },
    close: async () => {
      // Never remove the root or stop its server while the owned child or our
      // I/O callbacks remain unconfirmed. Preserve them for explicit recovery.
      if (used && (!childExited || !streamsDrained)) {
        detach?.(); broker.unref();
        throw new Error("Owned watcher fixture retained: child exit or I/O drain unconfirmed");
      }
      await broker.stop(true);
      await rm(base, { recursive: true, force: true });
    } };
}
function stopped(result: { out: string; err: string; code: number }, code: string) {
  expect(result.code).toBe(1); // Timeout/startup errors cannot pass as a usage refusal.
  expect(JSON.parse(result.err)).toEqual({ ok: false, error: { code, message: "Status unavailable under conversation usage settings" } });
  expect(result.err).not.toContain("Orbit not running");
}

unixTest("direct watcher starts off with zero broker calls and no status disclosure", async () => {
  const state = await fixture();
  try {
    await state.put(false);
    const result = await state.run();
    stopped(result, "ORBIT_DISABLED");
    expect(result.out).toBe("");
    expect(state.requests).toEqual([]);
    expect(result.err).not.toContain(state.socket);
    expect(result.err).not.toContain(state.id);
  } finally { await state.close(); }
}, 15000);

unixTest("direct watcher invalid environment is terminal before broker calls", async () => {
  const state = await fixture();
  try {
    const result = await state.run({ id: " private-padded-conversation " });
    stopped(result, "INVALID_REQUEST");
    expect(result.out).toBe("");
    expect(result.err).not.toContain("private-padded-conversation");
    expect(state.requests).toEqual([]);
  } finally { await state.close(); }
}, 15000);

unixTest("malformed stored usage stops watcher rather than polling a supposedly absent broker", async () => {
  const state = await fixture();
  try {
    await writeFile(state.preference, '{"enabled":"private-invalid-value"}');
    const result = await state.run();
    stopped(result, "USAGE_STATE_INVALID");
    expect(result.out).toBe("");
    expect(result.err).not.toContain("private-invalid-value");
    expect(state.requests).toEqual([]);
  } finally { await state.close(); }
}, 15000);

unixTest("on watcher emits metadata then observes off and exits without another emission", async () => {
  const state = await fixture();
  try {
    let emitted = 0;
    const result = await state.run({ onLine: async line => {
      const status = JSON.parse(line) as { sessions?: { title?: string }[] };
      expect(status.sessions?.[0]?.title).toBe("private-status-fixture");
      emitted++;
      if (emitted === 1) await state.put(false);
    } });
    stopped(result, "ORBIT_DISABLED");
    expect(emitted).toBe(1);
    expect(state.requests).toEqual(["session.list", "session.presence"]);
    expect(result.out.trim().split("\n")).toHaveLength(1);
  } finally { await state.close(); }
}, 15000);

unixTest("off during an admitted presence read discards its result before output", async () => {
  const state = await fixture();
  try {
    state.setRoute(async method => {
      if (method === "session.list") return { ok: true, result: [{ sessionId: "owned-session", state: "running", backend: "native", activity: { state: "working" } }] };
      await state.put(false);
      return { ok: true, result: { title: "private-do-not-deliver", tabs: [], pointer: null } };
    });
    const result = await state.run();
    stopped(result, "ORBIT_DISABLED");
    expect(result.out).toBe("");
    expect(state.requests).toEqual(["session.list", "session.presence"]);
    expect(result.err).not.toContain("private-do-not-deliver");
    // The presence was already admitted. This proves suppression, not cancellation.
  } finally { await state.close(); }
}, 15000);

unixTest("off racing broker failure stays terminal usage refusal not Orbit not running", async () => {
  const state = await fixture();
  try {
    state.setRoute(async () => {
      await state.put(false);
      return { ok: false, error: { code: "BACKEND_ERROR", message: "private-broker-error" } };
    });
    const result = await state.run();
    stopped(result, "ORBIT_DISABLED");
    expect(result.out).toBe("");
    expect(result.err).not.toContain("private-broker-error");
    expect(state.requests).toEqual(["session.list"]);
  } finally { await state.close(); }
}, 15000);


unixTest("off during list completion refuses all later presence requests", async () => {
  const state = await fixture();
  try {
    state.setRoute(async method => {
      if (method === "session.list") {
        await state.put(false);
        return { ok: true, result: [{ sessionId: "must-not-query-presence", state: "running", backend: "native", activity: { state: "working" } }] };
      }
      return { ok: true, result: { title: "private-must-not-read", tabs: [] } };
    });
    const result = await state.run();
    stopped(result, "ORBIT_DISABLED");
    expect(result.out).toBe("");
    expect(state.requests).toEqual(["session.list"]);
    expect(result.err).not.toContain("private-must-not-read");
    // The accepted list completed; only subsequent requests were refused.
  } finally { await state.close(); }
}, 15000);
