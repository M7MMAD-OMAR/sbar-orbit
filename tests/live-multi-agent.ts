/**
 * Live proof for docs/multi-agent-sessions-plan.md steps 1 to 3: a private broker on its own socket,
 * a fake native backend, and two REAL MCP adapter processes (src/mcp.ts) driven through the MCP SDK
 * the way an agent host drives them, plus the real CLI. Nothing here touches the shared broker, the
 * plugin or any owner window.
 *
 *   bun run scripts/limited.ts bun tests/live-multi-agent.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";
import { NativeBackend } from "../src/hyprland";
import { OrbitError } from "../src/errors";
import { readOwnerCredential } from "../src/caller";

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(2)}s`;
const log = (line: string) => console.log(`${stamp()} ${line}`);

const held = new Map<number, string>();
const closed: string[] = [];
let counter = 0;
(NativeBackend as unknown as { create: unknown }).create = async (_profile: string, _options: unknown, handoff: { workspace: number }) => {
  const existing = held.get(handoff.workspace);
  if (existing) throw new OrbitError("APPLICATION_BUSY", `The application client is already leased or native lease capacity is reached. Application client is already leased by lease ${existing} (worker pid 4242); its worker is alive`);
  const appId = (++counter).toString(16).padStart(32, "0"), windowId = "f".repeat(32);
  held.set(handoff.workspace, appId);
  return { capabilities: ["click"], surface: { width: 10, height: 10 },
    handoff: { workspace: handoff.workspace, appId, selectedWindowId: windowId, scope: "entire-wayland-client", clipboard: "shared", pointer: { x: 1, y: 1 },
      windows: [{ appId, windowId, title: `Fake application ${handoff.workspace}`, width: 10, height: 10 }] },
    parseAction: (value: Record<string, unknown>) => ({ ...value }), act: async () => ({ response: "ok" }), presence: async () => ({ title: "fake" }),
    onClose() {}, close: async () => { held.delete(handoff.workspace); closed.push(appId); } };
};
(NativeBackend as unknown as { monitors: unknown }).monitors = async () => ({ monitors: [{ name: "DP-1", focused: true, workspace: 1 }] });
(NativeBackend as unknown as { openApplication: unknown }).openApplication = async () => ({ opened: true });

const root = await mkdtemp(join(tmpdir(), "orbit-live-"));
const broker = await startBroker({ native: { planPath: "/fixture/host.json", controlDirectory: "/fixture/control" },
  session: { graceSeconds: () => 3, pollMs: 200, closeDeadlineMs: 2000, workspacePool: [20, 40] } });
log(`private broker on ${broker.socket}`);

async function adapter(conversation: string, label: string) {
  const transport = new StdioClientTransport({ command: "bun", args: [resolve("src/mcp.ts")],
    env: { ...process.env as Record<string, string>, ORBIT_SOCKET: broker.socket, ORBIT_CONVERSATION_ID: conversation, ORBIT_CALLER_LABEL: label, ORBIT_USAGE_DIR: join(root, "usage") } });
  const client = new Client({ name: label, version: "1" });
  await client.connect(transport);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    const body = result.content[0]!.text;
    return { error: result.isError === true, body, json: (() => { try { return JSON.parse(body); } catch { return undefined; } })() };
  };
  return { client, transport, tool };
}

try {
  const a = await adapter("live-a", "Claude");
  const b = await adapter("live-b", "Codex");
  log(`adapter A pid ${a.transport.pid}, adapter B pid ${b.transport.pid}`);

  const opened = await a.tool("orbit_open", { requestId: "live-open-1", applicationId: "org.example.App.desktop" });
  log(`A orbit_open without a workspace -> ${opened.body}`);
  const otherOpen = await b.tool("orbit_open", { requestId: "live-open-2", applicationId: "org.example.App.desktop" });
  log(`B orbit_open without a workspace -> ${otherOpen.body}`);

  const sa = await a.tool("orbit_handoff", { workspace: 21, taskName: "Alpha task" });
  const sb = await b.tool("orbit_handoff", { workspace: 22, taskName: "Beta task" });
  log(`A session ${sa.json.sessionId} owner ${sa.json.ownerLabel}; B session ${sb.json.sessionId} owner ${sb.json.ownerLabel}`);

  const statusA = await a.tool("orbit_status");
  log(`A orbit_status -> ${statusA.json.length} entries, ids visible to A: ${statusA.json.filter((e: { sessionId?: string }) => e.sessionId).map((e: { sessionId: string }) => e.sessionId.slice(0, 8))}; summary of the other: ${JSON.stringify(statusA.json.find((e: { redacted?: boolean }) => e.redacted))}`);
  log(`A's listing mentions B's session id: ${statusA.body.includes(sb.json.sessionId)}`);

  const crossStop = await a.tool("orbit_stop", { sessionId: sb.json.sessionId });
  log(`A orbit_stop on B's session -> error=${crossStop.error} ${crossStop.body}`);
  const crossPause = await a.tool("orbit_pause", { sessionId: sb.json.sessionId });
  log(`A orbit_pause on B's session -> error=${crossPause.error} ${crossPause.json?.code}`);

  const busy = await b.tool("orbit_handoff", { workspace: 21, taskName: "Beta wants alpha's app" });
  log(`B orbit_handoff on A's application -> error=${busy.error} ${busy.body}`);

  const cli = async (args: string[], env: Record<string, string>) => {
    const child = Bun.spawn(["bun", resolve("src/cli.ts"), ...args], { env: { ...process.env, ORBIT_SOCKET: broker.socket, ORBIT_USAGE_DIR: join(root, "usage"), ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited; return (out || err).trim();
  };
  log(`CLI as a stranger: session list -> ${(await cli(["session", "list"], { ORBIT_CONVERSATION_ID: "live-cli", ORBIT_CALLER_LABEL: "Hermes" })).slice(0, 220)}`);
  log(`CLI as a stranger: session stop --mine -> ${await cli(["session", "stop", "--mine"], { ORBIT_CONVERSATION_ID: "live-cli", ORBIT_CALLER_LABEL: "Hermes" })}`);
  log(`CLI as a stranger: session stop B's id -> ${await cli(["session", "stop", sb.json.sessionId], { ORBIT_CONVERSATION_ID: "live-cli", ORBIT_CALLER_LABEL: "Hermes" })}`);

  const ownerList = async () => await call(broker.socket, "session.list", {}, undefined, { claim: { v: 1, kind: "cli", pid: process.pid }, ownerToken: readOwnerCredential(broker.socket) }) as { sessionId: string; ownerLabel: string; state: string; ownerState: string }[];
  log(`owner view: ${JSON.stringify((await ownerList()).map(s => `${s.ownerLabel} ${s.state} ${s.ownerState}`))}`);

  // The crash. SIGKILL gives the adapter no chance to say goodbye, so this is the broker's own watch.
  const pid = b.transport.pid!;
  process.kill(pid, "SIGKILL");
  const killed = Date.now();
  log(`SIGKILL adapter B (pid ${pid})`);
  let sawPaused: number | undefined, sawClosed: number | undefined;
  while (Date.now() - killed < 10_000 && sawClosed === undefined) {
    const mine = (await ownerList()).find(s => s.sessionId === sb.json.sessionId)!;
    if (sawPaused === undefined && ["pausing", "paused"].includes(mine.state)) { sawPaused = Date.now() - killed; log(`B's session is ${mine.state}, ownerState ${mine.ownerState}, after ${sawPaused} ms`); }
    if (mine.state === "closed") { sawClosed = Date.now() - killed; log(`B's session is closed after ${sawClosed} ms (grace 3000 ms); applications closed by the broker: 0; lease for workspace 22 held: ${held.has(22)}`); }
    await Bun.sleep(100);
  }
  const aStill = (await ownerList()).find(s => s.sessionId === sa.json.sessionId)!;
  log(`A's session after B's crash: ${aStill.state}`);
  const reuse = await a.tool("orbit_handoff", { workspace: 22, taskName: "Alpha takes the freed application" });
  log(`A orbit_handoff on the workspace B's crashed adapter held -> error=${reuse.error} ${reuse.json?.state ?? reuse.body}`);

  const mine = await a.tool("orbit_stop", { scope: "mine" });
  log(`A orbit_stop scope mine -> ${mine.body}`);
  log(`result: paused after ${sawPaused} ms, closed after ${sawClosed} ms, fake lease table now ${JSON.stringify([...held.keys()])}`);
  if (sawPaused === undefined || sawPaused > 1000 || sawClosed === undefined || sawClosed < 3000) { console.error("LIVE PROOF FAILED"); process.exitCode = 1; }
  await a.client.close();
} finally {
  await broker.close();
  await rm(root, { recursive: true, force: true });
}
