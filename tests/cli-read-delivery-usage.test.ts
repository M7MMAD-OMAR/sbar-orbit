import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationUsage } from "../src/conversation-usage";

const linux = process.platform === "linux" ? test : test.skip;
const PRIVATE = "PRIVATE-admitted-cli-read-owner-window";
const DIAGNOSTIC = "PRIVATE-cli-broker-diagnostic";
const PIXELS = Buffer.from("PRIVATE-owned-pixels");
const FRAME = { mimeType: "image/png", image: PIXELS.toString("base64"), title: PRIVATE };
const retained = new Set<OwnedCli>();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned CLI completion unknown")), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
class OwnedCli {
  root?: string;
  socket?: string;
  usage?: ConversationUsage;
  server?: ReturnType<typeof Bun.serve>;
  readonly conversation = "cli-read-" + crypto.randomUUID();
  readonly token = randomBytes(32).toString("hex");
  readonly pending = new Set<Promise<unknown>>();
  readonly children = new Set<Bun.Subprocess>();
  readonly requests: { method: string; owner: boolean }[] = [];
  readonly plans: { seen: ReturnType<typeof deferred<{ method: string }>>; release: ReturnType<typeof deferred<void>>; response: unknown }[] = [];
  readonly queue: OwnedCli["plans"] = [];
  closing = false;
  uncertain = false;
  startupUnknown = false;
  open() { if (this.closing) throw new Error("Owned fixture admissions closed"); }
  track<T>(p: Promise<T>) { this.pending.add(p); void p.then(() => { this.pending.delete(p); }, () => { this.pending.delete(p); }); return p; }
  async setup() {
    this.root = await this.track(mkdtemp("/tmp/ovr-")); this.open();
    const socket = join(this.root, "b"); this.socket = socket;
    const usage = new ConversationUsage(this.conversation, join(this.root, "u")); this.usage = usage;
    await this.track(usage.set("on")); this.open();
    await this.track(writeFile(socket + ".owner", this.token + "\n", { mode: 0o600, flag: "wx" })); this.open();
    this.startupUnknown = true;
    this.server = Bun.serve({ unix: socket, fetch: request => {
      const admitted = !this.closing;
      return this.track((async () => {
        if (!admitted) return Response.json({ ok: false, error: { code: "FIXTURE_CLOSING", message: "Owned peer closing" } }, { status: 503, headers: { Connection: "close" } });
        const rpc = await request.json() as { method: string };
        this.requests.push({ method: rpc.method, owner: request.headers.get("x-orbit-owner") === this.token });
        const plan = this.queue.shift();
        if (!plan) return Response.json({ ok: false, error: { code: "UNEXPECTED_FIXTURE_RPC", message: "Unexpected fixture request" } }, { headers: { Connection: "close" } });
        plan.seen.resolve(rpc); await plan.release.promise;
        return Response.json(plan.response, { headers: { Connection: "close" } });
      })());
    } });
    this.startupUnknown = false;
    await this.track(chmod(socket, 0o600)); this.open();
  }
  path(name: string) { const root = this.root; if (!root) throw new Error("Root unavailable"); return join(root, name); }
  set(mode: "on" | "off") { this.open(); const usage = this.usage; if (!usage) throw new Error("Usage unavailable"); return this.track(usage.set(mode)); }
  corrupt() {
    this.open(); const name = createHash("sha256").update(this.conversation).digest("hex") + ".json";
    return this.track(writeFile(this.path("u/" + name), PRIVATE + "{", { mode: 0o600 }));
  }
  plan(response: unknown) { this.open(); const p = { seen: deferred<{ method: string }>(), release: deferred<void>(), response }; this.plans.push(p); this.queue.push(p); return p; }
  run(args: string[], debug = false, fallbackMarker?: string) {
    this.open(); const root = this.root, socket = this.socket; if (!root || !socket) throw new Error("Peer unavailable");
    // Known one-shot CLI only. No native broker/app, stdin producer or numeric signals.
    const cli = join(import.meta.dir, "../src/cli.ts");
    const argv = [process.execPath, cli, "--owner", ...args];
    const program = fallbackMarker ? [
      "const { Diagnostics } = await import(" + JSON.stringify(join(import.meta.dir, "../src/diagnostics.ts")) + ");",
      "const { writeFile } = await import('node:fs/promises'); const original = Diagnostics.prototype.report;",
      "Diagnostics.prototype.report = async function(...args) { await writeFile(" + JSON.stringify(fallbackMarker) + ", 'OWNED_FALLBACK_ENTERED', {flag: 'wx', mode: 0o600}); return Reflect.apply(original, this, args); };",
      "process.argv = " + JSON.stringify(argv) + "; await import(" + JSON.stringify(cli) + ");",
    ].join("\n") : undefined;
    // Observer is confined to this owned child and never replaces report results.
    const child = Bun.spawn(program ? [process.execPath, "-e", program] : argv, {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8", ORBIT_SOCKET: socket,
        ORBIT_CONVERSATION_ID: this.conversation, ORBIT_USAGE_DIR: join(root, "u"), XDG_STATE_HOME: join(root, "s"),
        XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_CACHE_HOME: join(root, "k"), XDG_RUNTIME_DIR: join(root, "r"),
        ...(debug ? { ORBIT_DEBUG: "1" } : {}),
      },
    });
    this.children.add(child);
    const exited = this.track(child.exited), out = this.track(new Response(child.stdout).text()), err = this.track(new Response(child.stderr).text());
    const completed = this.track(Promise.all([out, err, exited]).then(([out, err, code]) => {
      this.children.delete(child); return { out, err, code };
    }, error => { this.uncertain = true; throw error; }));
    return bounded(completed);
  }
  async settle() { const end = performance.now()+4000; while (this.pending.size) await bounded(Promise.allSettled([...this.pending]), Math.max(1, end-performance.now())); }
  async close() {
    this.closing = true; for (const plan of this.plans) plan.release.resolve(undefined);
    try {
      if (this.startupUnknown) throw new Error("Peer startup unknown");
      const stopped = this.server ? Promise.resolve(this.server.stop(false)) : Promise.resolve(); void stopped.catch(() => {});
      await this.settle(); await bounded(stopped); await this.settle();
      if (this.uncertain || this.children.size) throw new Error("CLI exit or EOF unknown");
    } catch {
      retained.add(this); this.server?.unref(); for (const child of this.children) child.unref();
      throw new Error("Owned CLI fixture unconfirmed; peer/root retained");
    }
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
async function fixture(work: (f: OwnedCli) => Promise<void>) {
  const f = new OwnedCli(); let primary: unknown, failed = false;
  try { await bounded(f.track(f.setup())); await bounded(f.track(Promise.resolve().then(() => work(f))), 10000); }
  catch (error) { primary = error; failed = true; }
  try { await f.close(); } catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], "CLI fixture and cleanup failed"); throw cleanup; }
  if (failed) throw primary;
}
function blocked(value: { out: string; err: string; code: number }, code = "ORBIT_DISABLED") {
  expect(value.code).toBe(1); expect(value.out).toBe("");
  expect(JSON.parse(value.err)).toMatchObject({ ok: false, error: { code } });
  for (const secret of [PRIVATE, DIAGNOSTIC, FRAME.image]) expect(value.out + value.err).not.toContain(secret);
}
async function absent(path: string) { try { await stat(path); throw new Error("Observation output unexpectedly exists"); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOENT"); } }

linux("common CLI read methods suppress accepted late private success after off", () => fixture(async f => {
  const specs = [
    { args: ["session", "observe", "owned-session"], method: "session.observe" },
    { args: ["session", "observe", "owned-session", "--metadata"], method: "session.presence" },
    { args: ["session", "list"], method: "session.list" },
    { args: ["session", "journal", "owned-session"], method: "session.journal" },
    { args: ["applications"], method: "applications.list" },
    { args: ["native-monitors"], method: "native.monitors" },
    { args: ["native-candidates", "7"], method: "native.candidates" },
    { args: ["doctor"], method: "doctor" },
    { args: ["views", "status"], method: "views.owner-status" },
  ];
  for (const spec of specs) {
    await f.set("on"); const plan = f.plan({ ok: true, result: FRAME }); const pending = f.run(spec.args);
    expect((await bounded(plan.seen.promise)).method).toBe(spec.method);
    await f.set("off"); plan.release.resolve(undefined); blocked(await pending);
  }
  expect(f.requests).toEqual(specs.map(spec => ({ method: spec.method, owner: true })));
}), 20000);

linux("common CLI read errors suppress private broker metadata including debug stack", () => fixture(async f => {
  for (const debug of [false, true]) {
    await f.set("on"); const plan = f.plan({ ok: false, error: { code: "SESSION_NOT_OWNED", message: PRIVATE, diagnosticId: DIAGNOSTIC } });
    const pending = f.run(["session", "observe", "owned-session"], debug); await bounded(plan.seen.promise);
    await f.set("off"); plan.release.resolve(undefined); blocked(await pending);
  }
  expect(f.requests).toHaveLength(2);
}), 15000);

linux("CLI observation file is not created after observed off or invalid preference", () => fixture(async f => {
  for (const mode of ["off", "invalid"] as const) {
    await f.set("on"); const output = f.path(mode + "-capture.png"), plan = f.plan({ ok: true, result: FRAME });
    const pending = f.run(["session", "observe", "owned-session", "--output", output]);
    expect((await bounded(plan.seen.promise)).method).toBe("session.observe");
    if (mode === "off") await f.set("off"); else await f.corrupt();
    plan.release.resolve(undefined); blocked(await pending, mode === "off" ? "ORBIT_DISABLED" : "USAGE_STATE_INVALID");
    await absent(output);
  }
  expect(f.requests).toHaveLength(2);
}), 15000);

linux("enabled CLI preserves successful file output and original broker errors", () => fixture(async f => {
  const output = f.path("enabled-capture.png"), plan = f.plan({ ok: true, result: FRAME });
  const pending = f.run(["session", "observe", "owned-session", "--output", output]);
  await bounded(plan.seen.promise); plan.release.resolve(undefined);
  const value = await pending; expect(value.code).toBe(0); expect(value.err).toBe("");
  expect(JSON.parse(value.out)).toMatchObject({ ok: true, result: { title: PRIVATE, bytes: PIXELS.length, path: output } });
  expect(await f.track(readFile(output))).toEqual(PIXELS);
  const refused = f.plan({ ok: false, error: { code: "SESSION_NOT_OWNED", message: PRIVATE } });
  const rejected = f.run(["applications"]); await bounded(refused.seen.promise); refused.release.resolve(undefined);
  const result = await rejected; expect(result.code).toBe(1); expect(result.out).toBe("");
  expect(JSON.parse(result.err)).toMatchObject({ error: { code: "SESSION_NOT_OWNED", message: PRIVATE } });
}), 15000);

linux("accepted CLI mutation receipt and embedded readback remain visible after off", () => fixture(async f => {
  const plan = f.plan({ ok: true, result: { receipts: [{ token: "ACCEPTED_FIXED_RECEIPT" }], capture: FRAME } });
  const action = JSON.stringify({ type: "move", appId: "a".repeat(32), windowId: "b".repeat(32), x: 1, y: 2 });
  const pending = f.run(["act", "owned-session", action]); expect((await bounded(plan.seen.promise)).method).toBe("session.act");
  await f.set("off"); plan.release.resolve(undefined);
  const result = await pending; expect(result.code).toBe(0); expect(result.err).toBe("");
  expect(result.out).toContain("ACCEPTED_FIXED_RECEIPT"); expect(result.out).toContain(FRAME.image);
  // Intentional exception, not universal content suppression or cancellation.
  expect(f.requests).toHaveLength(1);
  await f.set("on");
  const refused = f.plan({ ok: false, error: { code: "INVALID_REQUEST", message: PRIVATE, diagnosticId: DIAGNOSTIC } });
  const failed = f.run(["act", "owned-session", action], true); await bounded(refused.seen.promise);
  await f.set("off"); refused.release.resolve(undefined);
  const failure = await failed; expect(failure.code).toBe(1); expect(failure.out).toBe("");
  expect(JSON.parse(failure.err)).toMatchObject({ error: { code: "INVALID_REQUEST", message: PRIVATE, diagnosticId: DIAGNOSTIC } });
  expect(f.requests).toHaveLength(2);
}), 15000);

linux("diagnostics late success or failure after off never invokes local fallback or emits report", () => fixture(async f => {
  const cases = [
    { response: { ok: true, result: { title: PRIVATE, image: FRAME.image } }, mode: "off" },
    { response: { ok: false, error: { code: "SESSION_NOT_OWNED", message: PRIVATE, diagnosticId: DIAGNOSTIC } }, mode: "off" },
    { response: { ok: false, error: { code: "SESSION_NOT_OWNED", message: PRIVATE, diagnosticId: DIAGNOSTIC } }, mode: "invalid" },
  ];
  for (const [index, scenario] of cases.entries()) {
    await f.set("on"); const marker = f.path("fallback-blocked-" + index), plan = f.plan(scenario.response);
    const pending = f.run(["diagnostics"], true, marker);
    expect((await bounded(plan.seen.promise)).method).toBe("diagnostics.report");
    if (scenario.mode === "off") await f.set("off"); else await f.corrupt();
    plan.release.resolve(undefined); blocked(await pending, scenario.mode === "off" ? "ORBIT_DISABLED" : "USAGE_STATE_INVALID");
    await absent(marker);
  }
  expect(f.requests).toHaveLength(3);
}), 20000);

linux("enabled diagnostics failure still executes actual local read-only report fallback", () => fixture(async f => {
  const marker = f.path("fallback-positive"), plan = f.plan({ ok: false, error: { code: "SESSION_NOT_OWNED", message: PRIVATE } });
  const pending = f.run(["diagnostics"], false, marker); await bounded(plan.seen.promise); plan.release.resolve(undefined);
  const result = await pending; expect(result.code).toBe(0); expect(result.err).toBe("");
  expect(JSON.parse(result.out)).toMatchObject({ schemaVersion: 1, events: [] });
  expect((await f.track(readFile(marker, "utf8")))).toBe("OWNED_FALLBACK_ENTERED");
  expect(f.requests).toHaveLength(1);
}), 15000);
