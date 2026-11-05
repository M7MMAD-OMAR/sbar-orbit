import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ConversationUsage } from "../src/conversation-usage";

const linux = process.platform === "linux" ? test : test.skip;
const conversation = "owned-status-errors";
const privateMessage = "OWNED-PRIVATE-OWNER-METADATA";
const privateDiagnostic = "OWNED-PRIVATE-DIAGNOSTIC";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
async function preserving(work: () => Promise<void>, cleanup: () => Promise<void>) {
  let failed = false, primary: unknown;
  try { await work(); } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (cleanupError) {
    if (failed) throw new AggregateError([primary, cleanupError], "Owned CLI error fixture and cleanup failed");
    throw cleanupError;
  }
  if (failed) throw primary;
}
async function fixture() {
  const root = await mkdtemp("/tmp/ove-"), socket = join(root, "b"), token = randomBytes(32).toString("hex");
  const usage = new ConversationUsage(conversation, join(root, "u")), entered = deferred<void>(), release = deferred<void>();
  const calls: { method: string; owner: boolean }[] = [], exits = new Set<Promise<number>>(), reads = new Set<Promise<unknown>>();
  const state = { hold: false, callbacks: 0 };
  let server: ReturnType<typeof Bun.serve> | undefined;
  const close = async () => {
    if (exits.size || reads.size || state.callbacks) throw new Error("Owned CLI exit or callback unconfirmed; server and root retained");
    await server?.stop(true); await rm(root, { recursive: true, force: true });
  };
  try {
    await writeFile(socket + ".owner", token + "\n", { mode: 0o600, flag: "wx" });
    server = Bun.serve({ unix: socket, async fetch(request) {
      state.callbacks++;
      try {
        const body = await request.json() as { method?: unknown };
        const method = String(body.method); calls.push({ method, owner: request.headers.get("x-orbit-owner") === token });
        if (method !== "session.list") return Response.json({ ok: false, error: { code: "UNSUPPORTED", message: "Unexpected fixture method" } });
        entered.resolve(); if (state.hold) await release.promise;
        return Response.json({ ok: false, error: { code: "SESSION_NOT_OWNED", message: privateMessage, diagnosticId: privateDiagnostic } });
      } finally { state.callbacks--; }
    } });
    await chmod(socket, 0o600);
    const run = async (debug = false) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "--owner", "status", "--json"], {
        cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8", ORBIT_SOCKET: socket,
          ORBIT_USAGE_DIR: join(root, "u"), ORBIT_CONVERSATION_ID: conversation, XDG_STATE_HOME: join(root, "s"),
          XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_CACHE_HOME: join(root, "k"), XDG_RUNTIME_DIR: join(root, "r"),
          ...(debug ? { ORBIT_DEBUG: "1" } : {}),
        },
      });
      const exited = child.exited; exits.add(exited); void exited.then(() => { exits.delete(exited); }, () => {});
      const completed = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), exited]);
      reads.add(completed); void completed.then(() => { reads.delete(completed); }, () => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [out, err, code] = await Promise.race([completed, new Promise<never>((_yes, no) => {
          timer = setTimeout(() => no(new Error("Owned CLI completion unknown; fixture retained")), 4000);
        })]);
        return { out, err, code, error: (JSON.parse(err) as { error: { code: string; message: string; diagnosticId?: string; stack?: string[] } }).error };
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    return { root, usage, state, calls, entered, release, run, close };
  } catch (primary) {
    try { await close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "Owned CLI error setup and cleanup failed"); }
    throw primary;
  }
}

linux("enabled actual one-shot CLI preserves the original owned fake broker failure", async () => {
  const f = await fixture();
  await preserving(async () => {
    const value = await f.run();
    expect(value.code).toBe(1); expect(value.out).toBe(""); expect(value.error.code).toBe("SESSION_NOT_OWNED");
    expect(value.error.message).toBe(privateMessage);
    expect(f.calls).toEqual([{ method: "session.list", owner: true }]);
  }, f.close);
});

for (const debug of [false, true]) linux("off during admitted status failure suppresses broker metadata, debug=" + debug, async () => {
  const f = await fixture(); f.state.hold = true;
  const pending = settle(f.run(debug));
  await preserving(async () => {
    try {
      await Promise.race([f.entered.promise, pending.then(() => { throw new Error("CLI completed before controlled broker failure"); })]);
      await f.usage.set("off"); f.release.resolve();
      const outcome = await pending; if (!outcome.ok) throw outcome.error;
      const value = outcome.value;
      expect(value.code).toBe(1); expect(value.out).toBe(""); expect(value.error.code).toBe("ORBIT_DISABLED");
      expect(value.err).not.toContain(privateMessage); expect(value.err).not.toContain(privateDiagnostic); expect(value.err).not.toContain("SESSION_NOT_OWNED");
      expect(value.error.diagnosticId).toBeUndefined();
      expect(f.calls).toEqual([{ method: "session.list", owner: true }]);
    } finally { f.release.resolve(); await pending; }
  }, f.close);
});
