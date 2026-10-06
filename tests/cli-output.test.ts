import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRoot } from "./platform-support";

const python = Bun.which("python3") ?? Bun.which("python");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function pipedReply(verb: "observe" | "list", result: unknown) {
  const root = await fixtureRoot("orbit-cli-output-");
  await chmod(root, 0o700);
  const socket = join(root, "broker.sock");
  const methods: unknown[] = [];
  const server = Bun.serve({ unix: socket, async fetch(request) {
    const body = await request.json() as { method: string };
    methods.push(body.method);
    return Response.json({ ok: true, result });
  } });
  const home = join(root, "home");
  await mkdir(home);
  const env: Record<string, string> = { HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: root, ORBIT_USAGE_DIR: join(root, "usage"), ORBIT_SOCKET: socket };
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (!python) throw new Error("Python is required for the stdlib pipe fixture");
  const outputPath = join(root, "stdout.txt");
  const reader = String.raw`import json,subprocess,sys,time
args=[sys.argv[1],sys.argv[2],"session",sys.argv[3]]
if sys.argv[3]=="observe":args.append("11111111-1111-4111-8111-111111111111")
p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
 time.sleep(0.05)
 out,err=p.communicate(timeout=6)
except subprocess.TimeoutExpired:
 p.kill();p.communicate();raise
with open(sys.argv[4],"wb") as stream:stream.write(out)
print(json.dumps({"exit":p.returncode,"stderr":err.decode(),"stdoutBytes":len(out)}))`;
  const child = Bun.spawn([python, "-c", reader, process.execPath, cli, verb, outputPath],
    { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000 });
  try {
    const [report, err, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit).toBe(0);
    expect(err).toBe("");
    const measured = JSON.parse(report) as { exit: number; stderr: string; stdoutBytes: number };
    expect(measured.exit).toBe(0);
    expect(measured.stderr).toBe("");
    expect(methods).toEqual([`session.${verb}`]);
    const out = await readFile(outputPath, "utf8");
    const expected = `${JSON.stringify({ ok: true, result })}\n`;
    expect(measured.stdoutBytes).toBe(Buffer.byteLength(expected));
    expect(out).toBe(expected);
    expect(JSON.parse(out)).toEqual({ ok: true, result });
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(!python)("CLI observation JSON drains its complete image to a delayed pipe reader", async () => {
  await pipedReply("observe", { mimeType: "image/jpeg", image: "YWJj".repeat(24000),
    width: 1280, height: 800, capturedAt: 1, presence: { title: "Disposable capture" } });
}, 15000);

test.skipIf(!python)("CLI session list preserves large UTF-8 JSON and its final newline through a pipe", async () => {
  await pipedReply("list", Array.from({ length: 32 }, (_, index) => ({
    sessionId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    state: "running", backend: "browser", agentName: "Agent", taskName: "حالة ".repeat(16),
    surface: { width: 1280, height: 800 },
    capabilities: ["navigate", "fill", "click", "upload", "scroll", "read", "open-tab", "select-tab", "close-tab", "resize", "observe", "pause", "resume", "stop"],
    policy: { mode: "supervised", origins: "any", allow: ["read", "navigate", "write"], deny: ["irreversible"] },
  })));
}, 15000);
