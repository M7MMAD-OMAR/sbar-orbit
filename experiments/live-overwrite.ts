/**
 * What an in place update does to a broker that is already serving.
 *
 * The broker's own modules are statically imported and resolved when it starts, so replacing them under
 * a running process cannot reach it. Its child scripts are not: `src/native/supervise.py` is read from
 * disk at every session creation ([src/chrome.ts:75](../src/chrome.ts)). This measures what that costs,
 * in the two shapes an in place update actually has: a half written file, which is the window while a
 * copy runs, and a completed change of interface, which is what a real new version is.
 *
 * It never touches the live tree. Everything happens in a staged copy of the tracked source with the
 * project's own `node_modules` linked in, and the broker under test binds a private socket in a
 * temporary directory, so the person's own broker and the other agents' sessions are untouched.
 *
 * Run: bun run scripts/limited.ts bun run experiments/live-overwrite.ts
 */
import { mkdtemp, rm, mkdir, cp, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const project = resolve(import.meta.dir, "..");

async function call(socket: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch("http://localhost/rpc", {
    method: "POST", unix: socket, headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return await response.json() as { ok: boolean; result?: any; error?: { code: string; message: string } };
}

/** A copy of the tracked source, which is what an installed machine has. */
async function stageSource(into: string) {
  const listed = Bun.spawn(["git", "-C", project, "ls-files", "-z"], { stdout: "pipe" });
  const paths = (await new Response(listed.stdout).text()).split("\0").filter(Boolean)
    .filter(path => /^(src|bin|scripts|viewer|desktop)\//.test(path) || /^(package\.json|bun\.lock|tsconfig\.json)$/.test(path));
  for (const path of paths) {
    await mkdir(join(into, dirname(path)), { recursive: true });
    await cp(join(project, path), join(into, path));
  }
  // Linked rather than copied: the dependencies are 100 packages and are not what this measures.
  await symlink(join(project, "node_modules"), join(into, "node_modules"));
  return paths.length;
}

const root = await mkdtemp(join(tmpdir(), "orbit-overwrite-"));
const stage = join(root, "source");
const findings: Record<string, unknown> = {};
let broker: ReturnType<typeof Bun.spawn> | undefined;
try {
  findings.stagedFiles = await stageSource(stage);
  const supervisor = join(stage, "src/native/supervise.py");
  const original = await readFile(supervisor, "utf8");

  broker = Bun.spawn(["bun", "run", join(stage, "src/cli.ts"), "serve"],
    { cwd: stage, stdout: "pipe", stderr: "pipe", env: { ...process.env, ORBIT_SOCKET: "" } });
  const reader = broker.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  const socket = JSON.parse(first.split("\n")[0] ?? "{}").socket as string;
  if (!socket) throw new Error(`the staged broker printed no socket: ${first.slice(0, 200)}`);
  findings.socket = socket.startsWith("/tmp/");

  // A session created before anything is overwritten, which is the person's open work.
  const before = await call(socket, "session.create", { backend: "browser", agentName: "update-study", taskName: "before the overwrite" });
  findings.sessionBefore = before.ok ? "created" : before.error;
  const openSession = before.result?.sessionId as string | undefined;

  // Shape one: a half written file, which is what a copy in progress leaves behind for anything that
  // reads it in that window.
  await writeFile(supervisor, original.slice(0, Math.floor(original.length / 3)));
  const truncated = await call(socket, "session.create", { backend: "browser", agentName: "update-study", taskName: "during a copy" });
  findings.duringCopy = truncated.ok ? "created" : truncated.error;
  if (truncated.ok) await call(socket, "session.stop", { sessionId: truncated.result.sessionId });

  // Shape two: a completed change, which is what a new version is. The new supervisor takes a mode
  // argument the old broker does not pass, so it refuses the call it is given.
  await writeFile(supervisor, ["import sys",
    "if len(sys.argv) < 2 or sys.argv[1] != '--mode':",
    "    sys.stderr.write('supervise: --mode is required\\n')",
    "    raise SystemExit(2)",
  ].join("\n"));
  const changed = await call(socket, "session.create", { backend: "browser", agentName: "update-study", taskName: "after the update" });
  findings.afterUpdate = changed.ok ? "created" : changed.error;
  if (changed.ok) await call(socket, "session.stop", { sessionId: changed.result.sessionId });

  // The question the person cares about: did the session they were watching survive all of that?
  if (openSession) {
    const still = await call(socket, "session.observe", { sessionId: openSession, mode: "metadata" });
    findings.openSessionSurvived = still.ok ? "answered" : still.error;
    await call(socket, "session.stop", { sessionId: openSession });
  }

  await writeFile(supervisor, original);
  const restored = await call(socket, "session.create", { backend: "browser", agentName: "update-study", taskName: "after restoring the file" });
  findings.afterRestore = restored.ok ? "created" : restored.error;
  if (restored.ok) await call(socket, "session.stop", { sessionId: restored.result.sessionId });
} finally {
  broker?.kill("SIGTERM");
  await broker?.exited;
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(findings, null, 2));
