import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

// Run through the installed command, with no manual broker start and no public
// network dependency. The caller has already installed Orbit in a test account.
await requireResourceBudget();
const launcher = process.argv[2];
const frame = process.argv[3];
if (!launcher || !frame) throw new Error("Usage: installed-browser-smoke.ts LAUNCHER FRAME.jpg");
if (await Bun.file(frame).exists()) throw new Error("Choose an unused frame path; captures never overwrite existing files");
const installedLauncher = resolve(launcher);
const directory = await mkdtemp(join(tmpdir(), "orbit-installed-smoke-"));
const marker = `Orbit installed ${crypto.randomUUID()}`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch: () => new Response(`<html><title>Orbit installation</title><h1>${marker}</h1></html>`,
    { headers: { "content-type": "text/html" } }),
});
type Reply = { ok: boolean; result?: Record<string, unknown>; error?: { code?: string } };
async function invoke(args: string[], allowFailure = false): Promise<Reply> {
  const child = Bun.spawn([installedLauncher, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env,
      ORBIT_AGENT_NAME: "installation-test", ORBIT_TASK_NAME: "installed browser acceptance" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  let reply: Reply;
  try { reply = JSON.parse(code === 0 ? stdout : stderr); }
  catch { throw new Error(`Installed command returned no JSON: ${args[0]}, exit ${code}, stderr bytes ${stderr.length}`); }
  if (!allowFailure && (code !== 0 || !reply.ok)) throw new Error(`Installed command failed: ${args[0]}, ${reply.error?.code ?? code}`);
  return reply;
}
let sessionId: string | undefined;
async function action(value: Record<string, unknown>, allowFailure = false) {
  if (!sessionId) throw new Error("No session");
  const path = join(directory, "action.json");
  await writeFile(path, JSON.stringify(value));
  return invoke(["act", sessionId, `@${path}`], allowFailure);
}
const started = performance.now();
try {
  await invoke(["doctor"]);
  const created = await invoke(["session", "create", "browser"]);
  if (typeof created.result?.sessionId !== "string") throw new Error("No session ID");
  sessionId = created.result.sessionId;
  await action({ type: "navigate", url: `http://127.0.0.1:${server.port}/` });
  if ((await action({ type: "read", selector: "h1" })).result?.text !== marker)
    throw new Error("The installed browser did not render the fixture");
  await invoke(["session", "pause", sessionId]);
  const paused = await action({ type: "navigate", url: `http://127.0.0.1:${server.port}/paused` }, true);
  if (paused.ok || paused.error?.code !== "PAUSED") throw new Error("Pause did not refuse the agent action");
  await invoke(["session", "resume", sessionId]);
  await invoke(["session", "observe", sessionId, "--output", resolve(frame)]);
  if ((await Bun.file(frame).arrayBuffer()).byteLength === 0) throw new Error("Empty frame");
  await invoke(["session", "stop", sessionId]);
  sessionId = undefined;
  console.log(JSON.stringify({ ok: true, platform: process.platform,
    elapsedMs: Math.round(performance.now() - started),
    checks: ["managed broker", "installed launcher", "navigate", "rendered text", "pause refusal", "resume", "capture", "stop"],
    frame: resolve(frame) }));
} finally {
  if (sessionId) await invoke(["session", "stop", sessionId]).catch(() => {});
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
