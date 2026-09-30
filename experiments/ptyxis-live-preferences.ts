/** Bidirectional preference signals and actual rendering, with two disposable Orbit owners. */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { FedoraBackend } from "../src/fedora";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const run = promisify(execFile);
const disabled = process.env.ORBIT_PTYXIS_DISABLE_BRIDGE === "1";
const output = join(process.cwd(), "output", `ptyxis-live-preferences${disabled ? "-no-bridge" : ""}-${new Date().toISOString().slice(0, 10)}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const source = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dconf/user");
const digest = async () => createHash("sha256").update(await readFile(source)).digest("hex");
const before = await digest();
const backends: FedoraBackend[] = [], workers: ChildProcessWithoutNullStreams[] = [];
const envs: NodeJS.ProcessEnv[] = [];
const cache: Record<string, unknown>[] = [];
const ready = new Set<number>(), pending = new Map<number, () => void>();
let sequence = 0, forwarded = 0, failure: Error | undefined, queue = Promise.resolve();
const report: Record<string, unknown> = { disabledBridgeControl: disabled };
async function waitFor(probe: () => Promise<boolean>, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (failure) throw failure;
    if (await probe()) return true;
    await Bun.sleep(100);
  }
  return false;
}
async function set(side: number, key: string, value: string) {
  const env = envs[side];
  if (!env) throw new Error("Missing private environment");
  await run("/usr/bin/gsettings", ["set", "org.gnome.Ptyxis", key, value], { env, timeout: 3000 });
}
async function get(side: number) {
  const env = envs[side];
  if (!env) throw new Error("Missing private environment");
  return (await run("/usr/bin/gsettings", ["get", "org.gnome.Ptyxis", "font-name"], { env, timeout: 3000 })).stdout.trim();
}
async function rejected(request: { id: number; key: string; value: unknown }) {
  const env = envs[0];
  if (!env) throw new Error("Missing validation environment");
  const worker = spawn("/usr/bin/python3", [join(process.cwd(), "experiments/ptyxis-preference-worker.py")], { env });
  workers.push(worker);
  worker.stderr.resume();
  return new Promise<boolean>(resolve => {
    let refused = false;
    const timer = setTimeout(() => { worker.kill("SIGKILL"); }, 3000);
    worker.on("error", () => { clearTimeout(timer); resolve(false); });
    worker.on("exit", code => { clearTimeout(timer); resolve(refused && code === 0); });
    createInterface({ input: worker.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line) as { event: string };
        if (message.event === "ready") worker.stdin.write(JSON.stringify(request) + "\n");
        if (message.event === "rejected") refused = true;
      } catch { worker.kill("SIGKILL"); }
    });
  });
}
async function launch(side: number) {
  const backend = backends[side];
  if (!backend) throw new Error("Missing owned display");
  await backend.act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/ptyxis", "--standalone", "--new-window", "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", 'printf "MMMMMMMMMMMMMMMM\\n"; sleep 120'] });
  await Bun.sleep(700);
}
async function frame(side: number, name: string) {
  const backend = backends[side];
  if (!backend) throw new Error("Missing owned display");
  const observed = await backend.observe();
  const path = join(output, `${name}.jpg`);
  await writeFile(path, Buffer.from(observed.image, "base64"));
  // Only the first terminal text row below the application's header. The fixture
  // has no personal content. White glyph span is independent of the blinking cursor.
  const script = "from PIL import Image; import sys,json; im=Image.open(sys.argv[1]).convert('RGB'); p=im.load(); rows=[(y,[x for x in range(im.width) if min(p[x,y])>150]) for y in range(75,160)]; rows=[(y,xs) for y,xs in rows if len(xs)>40]; top=rows[0][0] if rows else 0; xs=[x for y,row in rows if y<top+45 for x in row]; print(json.dumps({'span':max(xs)-min(xs)+1 if xs else 0}))";
  const result = JSON.parse((await run("/usr/bin/python3", ["-c", script, path], { timeout: 3000 })).stdout) as { span: number };
  return result.span;
}
try {
  for (let side = 0; side < 2; side++) {
    const backend = await FedoraBackend.create(); backends.push(backend);
    const env = { ...(backend as unknown as { env: NodeJS.ProcessEnv }).env }; envs.push(env);
    await set(side, "use-system-font", "false"); await set(side, "font-name", "'Monospace 18'");
    cache.push({});
    const worker = spawn("/usr/bin/python3", [join(process.cwd(), "experiments/ptyxis-preference-worker.py")], { env }); workers.push(worker);
    worker.stderr.resume(); worker.on("error", error => { failure = error; });
    worker.on("exit", () => { failure ??= new Error("Preference endpoint exited"); });
    createInterface({ input: worker.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line) as { event: string; values?: Record<string, unknown>; key?: string; value?: unknown; id?: number };
        if (message.event === "ready" && message.values) { cache[side] = message.values; ready.add(side); return; }
        if (message.event === "ack" && message.id) { pending.get(message.id)?.(); pending.delete(message.id); return; }
        if (message.event !== "changed" || !message.key) throw new Error("Preference endpoint rejected a request");
        const key = message.key, value = message.value;
        queue = queue.then(async () => {
          const own = cache[side], peer = cache[1 - side], target = workers[1 - side];
          if (!own || !peer || !target) throw new Error("Missing preference peer");
          own[key] = value;
          if (disabled || peer[key] === value) return;
          peer[key] = value;
          const id = ++sequence;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error("Preference write acknowledgement timed out")); }, 3000);
            pending.set(id, () => { clearTimeout(timer); resolve(); });
            target.stdin.write(JSON.stringify({ id, key, value }) + "\n");
          });
          forwarded++;
        }).catch(error => { failure = error; });
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    });
  }
  if (!await waitFor(async () => ready.size === 2)) throw new Error("Preference endpoints not ready");
  await launch(0); await launch(1);
  const small = await frame(1, "baseline");
  await set(0, "font-name", "'Monospace 36'");
  report.ownerToPrivate = await waitFor(async () => await get(1) === "'Monospace 36'", disabled ? 1500 : 10000);
  let large = await frame(1, "owner-change");
  report.privateRenderChanged = small > 0 && await waitFor(async () => {
    large = await frame(1, "owner-change"); return large > small * 1.5;
  }, disabled ? 1500 : 10000);
  if (!disabled) {
    await set(1, "font-name", "'Monospace 30'");
    report.privateToOwner = await waitFor(async () => await get(0) === "'Monospace 30'");
    let ownerWidth = await frame(0, "private-change");
    report.ownerRenderChanged = await waitFor(async () => {
      ownerWidth = await frame(0, "private-change"); return ownerWidth > small * 1.3 && ownerWidth < large;
    });
    const target = backends[1];
    if (!target) throw new Error("Missing private display");
    await target.act({ type: "window", command: "close", tab: 1 });
    if (!await waitFor(async () => (await target.presence()).pageCount === 0)) throw new Error("Private window did not close");
    await launch(1);
    const reopenedWidth = await frame(1, "reopened");
    report.reopened = reopenedWidth === ownerWidth && await get(1) === "'Monospace 30'";
    report.ownerGlyphSpan = ownerWidth;
    report.reopenedGlyphSpan = reopenedWidth;
  }
  report.glyphSpans = { small, large };
  await queue;
  report.forwardedWrites = forwarded;
  report.outsideKeyRejected = await rejected({ id: 1, key: "custom-command", value: "fixture" });
  report.wrongTypeRejected = await rejected({ id: 1, key: "use-system-font", value: 1 });
  report.fontUnchangedAfterRejectedWrites = await get(0) === (disabled ? "'Monospace 36'" : "'Monospace 30'");
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  for (const worker of workers) {
    worker.stdin.end();
    if (worker.exitCode === null) {
      await Promise.race([new Promise<void>(resolve => worker.once("exit", () => resolve())), Bun.sleep(1000)]);
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
  }
  for (const backend of backends.reverse()) await backend.close();
  report.originalPreferencesUnchanged = await digest() === before;
}
report.passed = ["ownerToPrivate", "privateToOwner", "privateRenderChanged", "ownerRenderChanged", "reopened", "originalPreferencesUnchanged", "outsideKeyRejected", "wrongTypeRejected", "fontUnchangedAfterRejectedWrites"].every(key => report[key] === true);
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
