import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationUsage } from "../src/conversation-usage";

const linux = process.platform === "linux" ? test : test.skip;
const conversation = "owned-cli-view-status";
const unavailable = { available: false, enabled: false, activeChannels: 0, readViews: 0 };
type Reply = { ok: boolean; result?: unknown; error?: { code: string; message: string } };
type CLI = { code: number; out: string; err: string; success?: Reply; failure?: Reply };
async function cli(socket: string, root: string, args: string[], running: Set<Promise<number>>, extra: Record<string, string> = {}, launcher = false): Promise<CLI> {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"), ORBIT_SOCKET: socket,
    ORBIT_USAGE_DIR: join(root, "usage"), ORBIT_CONVERSATION_ID: conversation, ORBIT_BUN: process.execPath, ...extra };
  const command = launcher ? [join(import.meta.dir, "../bin/sbar-orbit"), ...args] : [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args];
  const child = Bun.spawn(command, { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const exited = child.exited; running.add(exited);
  void exited.then(() => { running.delete(exited); }, () => {});
  const completed = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), exited]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [out, err, code] = await Promise.race([completed, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error("Owned CLI exit remains unconfirmed; fixture root retained")), 4000);
    })]);
    return { code, out, err, ...(out.trim() ? { success: JSON.parse(out) as Reply } : {}), ...(err.trim() ? { failure: JSON.parse(err) as Reply } : {}) };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function preserving<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let value!: T, failed = false, primary: unknown;
  try { value = await work(); } catch (error) { failed = true; primary = error; }
  try { await cleanup(); } catch (cleanupError) {
    if (failed) throw new AggregateError([primary, cleanupError], "Owned CLI work and cleanup failed");
    throw cleanupError;
  }
  if (failed) throw primary;
  return value;
}
function requireObservedExits(running: Set<Promise<number>>): void {
  if (running.size) throw new Error("Owned CLI child exit remains unconfirmed; broker and root retained");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-cli-view-status-")), socket = join(root, "private.sock"), token = randomBytes(32).toString("hex");
  const calls: { method: unknown; params: unknown; ownerPresented: boolean; ownerVerified: boolean }[] = [], running = new Set<Promise<number>>();
  const state = { unsupported: false };
  let server: ReturnType<typeof Bun.serve> | undefined;
  const close = async () => {
    requireObservedExits(running); // No socket/credential/root disposal while a child may still use it.
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  };
  try {
  await writeFile(socket + ".owner", token + "\n", { mode: 0o600, flag: "wx" });
  server = Bun.serve({ unix: socket, async fetch(request) {
    const body = await request.json() as { method?: unknown; params?: unknown };
    const owner = request.headers.get("x-orbit-owner"), verified = owner === token;
    calls.push({ method: body.method, params: body.params, ownerPresented: owner !== null, ownerVerified: verified });
    if (!verified) return Response.json({ ok: false, error: { code: "READ_VIEW_DENIED", message: "Read view request refused" } });
    if (state.unsupported || body.method !== "views.owner-status") return Response.json({ ok: false, error: { code: "UNSUPPORTED", message: "Old broker has no read-view metadata method" } });
    return Response.json({ ok: true, result: unavailable });
  } });
  await chmod(socket, 0o600);
  return { root, socket, token, calls, state, running,
    run: (args: string[], extra: Record<string, string> = {}, launcher = false) => cli(socket, root, args, running, extra, launcher), close };
  } catch (primary) {
    try { await close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "Owned broker setup and cleanup failed"); }
    throw primary;
  }
}

linux("actual Linux launcher owner CLI status sends one authenticated empty-params metadata request", async () => {
  const f = await fixture();
  await preserving(async () => {
    const result = await f.run(["--owner", "views", "status"], {}, true);
    expect(result.code).toBe(0); expect(result.err).toBe(""); expect(result.success).toEqual({ ok: true, result: unavailable });
    expect(f.calls).toEqual([{ method: "views.owner-status", params: {}, ownerPresented: true, ownerVerified: true }]);
    expect(result.out).not.toContain(f.token);
  }, f.close);
});

linux("agent and ORBIT_OWNER alone cannot invoke the new route or send any owner header", async () => {
  const f = await fixture();
  await preserving(async () => {
    for (const extra of [{}, { ORBIT_OWNER: "1" }] as Record<string, string>[]) {
      const result = await f.run(["views", "status"], extra);
      expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.failure?.error?.code).toBe("OWNER_REQUIRED");
      expect(result.err).not.toContain(f.token);
    }
    expect(f.calls).toEqual([]);
  }, f.close);
});

linux("owner views status rejects extra duplicate misplaced and mutation arguments before RPC", async () => {
  const f = await fixture();
  await preserving(async () => {
    for (const args of [["--owner", "views", "status", "private-extra"], ["--owner", "views", "status", "--json"],
      ["--owner", "views", "status", "--mine"], ["--owner", "--owner", "views", "status"], ["views", "status", "--owner"],
      ["--owner", "views", "--owner", "status"], ["--owner", "views", "enable"], ["--owner", "views"], ["--mine", "--owner", "views", "status"]]) {
      const result = await f.run(args);
      expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.failure?.error?.code).toBe("INVALID_REQUEST");
      expect(result.err).not.toContain("private-extra");
    }
    expect(f.calls).toEqual([]);
  }, f.close);
}, 30000);

linux("normal conversation off still blocks owner metadata without contacting the broker", async () => {
  const f = await fixture();
  await preserving(async () => {
    const usage = new ConversationUsage(conversation, join(f.root, "usage")); await usage.set("off");
    const result = await f.run(["--owner", "views", "status"]);
    expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.failure?.error?.code).toBe("ORBIT_DISABLED");
    expect(f.calls).toEqual([]); expect((await usage.status()).enabled).toBe(false);
  }, f.close);
});

linux("owned fake broker denial without a credential is propagated rather than invented unavailable success", async () => {
  const f = await fixture();
  await preserving(async () => {
    await unlink(f.socket + ".owner");
    const result = await f.run(["--owner", "views", "status"]);
    expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.failure?.error?.code).toBe("READ_VIEW_DENIED");
    expect(f.calls).toEqual([{ method: "views.owner-status", params: {}, ownerPresented: false, ownerVerified: false }]);
  }, f.close);
});

linux("old broker unsupported propagates as an error instead of invented zero counters", async () => {
  const f = await fixture(); f.state.unsupported = true;
  await preserving(async () => {
    const result = await f.run(["--owner", "views", "status"]);
    expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.failure?.error?.code).toBe("UNSUPPORTED");
    expect(result.failure?.result).toBeUndefined(); expect(f.calls.map(call => call.method)).toEqual(["views.owner-status"]);
  }, f.close);
});

linux("unobserved child exit preserves the private broker socket credential and root before any cleanup", async () => {
  const f = await fixture(); let release!: (code: number) => void;
  const unknown = new Promise<number>(resolve => { release = resolve; }); f.running.add(unknown);
  void unknown.then(() => { f.running.delete(unknown); });
  await preserving(async () => {
    await expect(f.close()).rejects.toThrow("broker and root retained");
    expect((await Bun.file(f.socket + ".owner").text()).trim() === f.token).toBe(true);
    const response = await fetch("http://localhost/rpc", { unix: f.socket, method: "POST",
      headers: { "Content-Type": "application/json", "x-orbit-owner": f.token }, body: JSON.stringify({ method: "views.owner-status", params: {} }) });
    expect(await response.json()).toEqual({ ok: true, result: unavailable });
  }, async () => { release(0); await unknown; await f.close(); });
});
