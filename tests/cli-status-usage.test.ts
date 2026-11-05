import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ConversationUsage } from "../src/conversation-usage";

const linux = process.platform === "linux" ? test : test.skip;
const conversation = "owned-one-shot-status-usage";
const privateTitle = "PRIVATE-admitted-presence-title";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
async function preserving(work: () => Promise<void>, cleanup: () => Promise<void>) {
  let primary: unknown, failed = false;
  try { await work(); } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (cleanupError) {
    if (failed) throw new AggregateError([primary, cleanupError], "Owned status fixture work and cleanup failed");
    throw cleanupError;
  }
  if (failed) throw primary;
}
async function fixture() {
  const root = await mkdtemp("/tmp/ovs-"), socket = join(root, "b"), token = randomBytes(32).toString("hex");
  const usage = new ConversationUsage(conversation, join(root, "u"));
  const listEntered = deferred<void>(), listRelease = deferred<void>(), presenceEntered = deferred<void>(), presenceRelease = deferred<void>();
  const state = { holdList: false, holdPresence: false, callbacks: 0, presenceCompleted: 0 };
  const calls: { method: string; owner: boolean }[] = [], exits = new Set<Promise<number>>(), reads = new Set<Promise<unknown>>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  const close = async () => {
    // No socket/credential/root deletion while either process exit, output EOF or a
    // controlled server callback remains unknown. No numeric signal or stop claim.
    if (exits.size || reads.size || state.callbacks) throw new Error("Owned status fixture still active; server and root retained");
    await server?.stop(true); await rm(root, { recursive: true, force: true });
  };
  try {
    await writeFile(socket + ".owner", token + "\n", { mode: 0o600, flag: "wx" });
    server = Bun.serve({ unix: socket, async fetch(request) {
      state.callbacks++;
      try {
        const body = await request.json() as { method?: unknown; params?: unknown };
        const method = String(body.method); calls.push({ method, owner: request.headers.get("x-orbit-owner") === token });
        if (method === "session.list") {
          listEntered.resolve(); if (state.holdList) await listRelease.promise;
          return Response.json({ ok: true, result: [{ sessionId: "owned-session", state: "running", backend: "native", agentName: "Fixture", taskName: "Read status",
            activity: { type: "observe", actor: "agent", state: "working", sequence: 1 } }] });
        }
        if (method === "session.presence") {
          presenceEntered.resolve(); if (state.holdPresence) await presenceRelease.promise;
          state.presenceCompleted++;
          return Response.json({ ok: true, result: { title: privateTitle, location: "owned-fixture", tabs: [], pointer: { x: 4, y: 5 } } });
        }
        return Response.json({ ok: false, error: { code: "UNSUPPORTED", message: "Only status metadata is supported by this fixture" } });
      } finally { state.callbacks--; }
    } });
    await chmod(socket, 0o600);
    const run = async (args = ["status", "--json"], extra: Record<string, string> = {}, afterPreflight?: () => Promise<void>) => {
      const cliPath = join(import.meta.dir, "../src/cli.ts"), marker = "OWNED_STATUS_INITIAL_PREFLIGHT_OK";
      const program = afterPreflight ? [
        "const { ConversationUsage } = await import(" + JSON.stringify(join(import.meta.dir, "../src/conversation-usage.ts")) + ");",
        "const original = ConversationUsage.prototype.assertEnabled; let announced = false;",
        "ConversationUsage.prototype.assertEnabled = async function(...args) { await Reflect.apply(original, this, args); if (!announced) { announced = true; console.log(" + JSON.stringify(marker) + "); } };",
        "process.argv = " + JSON.stringify([process.execPath, cliPath, ...args]) + ";",
        "await import(" + JSON.stringify(cliPath) + ");",
      ].join("\n") : undefined;
      const command = program ? [process.execPath, "-e", program] : [process.execPath, cliPath, ...args];
      const child = Bun.spawn(command, { cwd: root, stdin: afterPreflight ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8", ORBIT_SOCKET: socket,
        ORBIT_CONVERSATION_ID: conversation, ORBIT_USAGE_DIR: join(root, "u"), XDG_STATE_HOME: join(root, "s"),
        XDG_CONFIG_HOME: join(root, "c"), XDG_CACHE_HOME: join(root, "k"), XDG_DATA_HOME: join(root, "d"), XDG_RUNTIME_DIR: join(root, "r"), ...extra,
      } });
      const exited = child.exited; exits.add(exited); void exited.then(() => { exits.delete(exited); }, () => {});
      const initial = deferred<void>(); let preflightObserved = false;
      const output = (async () => {
        const reader = child.stdout.getReader(), decoder = new TextDecoder(); let text = "";
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            text += decoder.decode(part.value, { stream: true });
            if (text.length > 65536) throw new Error("Owned CLI output bound exceeded");
            if (afterPreflight && !preflightObserved && text.startsWith(marker + "\n")) { preflightObserved = true; initial.resolve(); }
          }
          text += decoder.decode();
          return preflightObserved ? text.slice(marker.length + 1) : text;
        } finally { reader.releaseLock(); }
      })();
      const input = afterPreflight ? (async () => {
        const sink = child.stdin as { write(value: string): unknown; end(): unknown };
        try {
          const ready = await Promise.race([initial.promise.then(() => true), output.then(() => false)]);
          if (ready) { await afterPreflight(); sink.write(JSON.stringify({ type: "state" })); }
        } finally { await sink.end(); }
      })() : Promise.resolve();
      const completed = Promise.all([output, new Response(child.stderr).text(), exited, input]);
      reads.add(completed); void completed.then(() => { reads.delete(completed); }, () => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [out, err, code] = await Promise.race([completed, new Promise<never>((_yes, no) => {
          timer = setTimeout(() => no(new Error("Status CLI completion unconfirmed; fixture retained")), 4000);
        })]);
        return { out, err, code, preflightObserved, json: out.trim() ? JSON.parse(out) as Record<string, unknown> : undefined,
          error: err.trim() ? (JSON.parse(err) as { error?: { code?: string } }).error : undefined };
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    return { root, socket, usage, state, calls, run, close, listEntered, listRelease, presenceEntered, presenceRelease };
  } catch (primary) {
    try { await close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "Owned status setup and cleanup failed"); }
    throw primary;
  }
}

linux("enabled one-shot status preserves canonical output and legacy explicit/env owner behavior", async () => {
  const f = await fixture();
  await preserving(async () => {
    for (const mode of ["agent", "flag", "env"] as const) {
      const before = f.calls.length;
      const value = await f.run(mode === "flag" ? ["--owner", "status", "--json"] : ["status", "--json"], mode === "env" ? { ORBIT_OWNER: "1" } : {});
      expect(value.code).toBe(0); expect(value.err).toBe("");
      if (!value.json) throw new Error("Expected status JSON");
      const { sampledAt, socket, ...status } = value.json;
      if (typeof sampledAt !== "string") throw new Error("Expected an ISO status timestamp");
      expect(new Date(sampledAt).toISOString()).toBe(sampledAt); expect(socket).toBe(f.socket);
      expect(status).toEqual({ running: 1, working: 1, paused: 0, tabs: 0, windows: 0,
        sessions: [{ sessionId: "owned-session", state: "running", backend: "native", agentName: "Fixture", taskName: "Read status",
          activity: { type: "observe", actor: "agent", state: "working", sequence: 1 }, title: privateTitle, location: "owned-fixture", tabs: [], pointer: { x: 4, y: 5 } }],
        summary: "1 session · 1 working" });
      expect(f.calls.slice(before)).toEqual([{ method: "session.list", owner: mode !== "agent" }, { method: "session.presence", owner: mode !== "agent" }]);
    }
  }, f.close);
}, 20000);

linux("preexisting usage off blocks one-shot owner status before any RPC", async () => {
  const f = await fixture();
  await preserving(async () => {
    await f.usage.set("off"); const value = await f.run(["status", "--json"], { ORBIT_OWNER: "1" });
    expect(value.code).toBe(1); expect(value.out).toBe(""); expect(value.error?.code).toBe("ORBIT_DISABLED"); expect(f.calls).toEqual([]);
  }, f.close);
});

linux("off during admitted list prevents subsequent presence and prints no status", async () => {
  const f = await fixture(); f.state.holdList = true;
  const pending = settle(f.run());
  await preserving(async () => {
    try {
      await Promise.race([f.listEntered.promise, pending.then(() => { throw new Error("CLI completed before controlled list"); })]);
      await f.usage.set("off"); f.listRelease.resolve();
      const value = await pending; if (!value.ok) throw value.error;
      expect(value.value.code).toBe(1); expect(value.value.out).toBe(""); expect(value.value.error?.code).toBe("ORBIT_DISABLED");
      expect(f.calls.map(call => call.method)).toEqual(["session.list"]); expect(f.state.presenceCompleted).toBe(0);
    } finally { f.listRelease.resolve(); f.presenceRelease.resolve(); await pending; }
  }, f.close);
});

linux("off after real CLI preflight while stdin remains open prevents dispatch after the document arrives", async () => {
  const f = await fixture(); let releasedAfterRealGate = false;
  await preserving(async () => {
    const value = await f.run(["act", "owned-session", "-"], {}, async () => {
      releasedAfterRealGate = true; expect(f.calls).toEqual([]); await f.usage.set("off");
    });
    expect(releasedAfterRealGate).toBe(true); expect(value.preflightObserved).toBe(true);
    expect(value.code).toBe(1); expect(value.out).toBe(""); expect(value.error?.code).toBe("ORBIT_DISABLED");
    expect(f.calls).toEqual([]);
  }, f.close);
});

linux("off during admitted presence suppresses its result without pretending to cancel the read", async () => {
  const f = await fixture(); f.state.holdPresence = true;
  const pending = settle(f.run());
  await preserving(async () => {
    try {
      await Promise.race([f.presenceEntered.promise, pending.then(() => { throw new Error("CLI completed before controlled presence"); })]);
      await f.usage.set("off"); f.presenceRelease.resolve();
      const value = await pending; if (!value.ok) throw value.error;
      expect(value.value.code).toBe(1); expect(value.value.out).toBe(""); expect(value.value.error?.code).toBe("ORBIT_DISABLED");
      expect(value.value.err).not.toContain(privateTitle); expect(f.state.presenceCompleted).toBe(1);
      expect(f.calls.map(call => call.method)).toEqual(["session.list", "session.presence"]);
    } finally { f.presenceRelease.resolve(); f.listRelease.resolve(); await pending; }
  }, f.close);
});
