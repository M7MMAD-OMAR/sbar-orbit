import { startBroker } from "../src/ipc";
import { join } from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const broker = await startBroker();
const command = process.execPath;
const entry = join(import.meta.dir, "../src/mcp.ts");
const config = { mcpServers: { orbit: { command, args: [entry], env: { ORBIT_SOCKET: broker.socket } } } };
const scratch = await mkdtemp(join(tmpdir(), "orbit-host-probe-"));
const invoke = async (args: string[], isolatedClaude = false) => {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", cwd: scratch,
    env: isolatedClaude ? { ...process.env, CLAUDE_CONFIG_DIR: scratch, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : process.env });
  const timeout = setTimeout(() => child.kill(), 20000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
};
try {
  const registration = await invoke(["claude", "mcp", "add-json", "--scope", "user", "orbit", JSON.stringify(config.mcpServers.orbit)], true);
  if (registration.code !== 0) throw new Error("Temporary Claude registration failed");
  const claude = await invoke(["claude", "mcp", "get", "orbit"], true);
  const codexConfig = `mcp_servers.orbit_probe={command=${JSON.stringify(command)},args=[${JSON.stringify(entry)}],env={ORBIT_SOCKET=${JSON.stringify(broker.socket)}}}`;
  const codex = await invoke(["codex", "-c", codexConfig, "mcp", "get", "orbit_probe", "--json"]);
  const evidence = {
    date: "2026-09-10",
    claude: { code: claude.code, connected: /Connected/.test(claude.stdout), scope: "temporary CLAUDE_CONFIG_DIR", output: claude.stdout.replace(/[\u2013\u2014]/g, ":") },
    codex: { code: codex.code, configAccepted: codex.code === 0, runtimeHandshakeTested: false },
    limits: "Host configuration and connection diagnostics only. No model-driven task was requested; no permanent host configuration changed.",
  };
  await mkdir(join(import.meta.dir, "../output/connectors"), { recursive: true });
  await Bun.write(join(import.meta.dir, "../output/connectors/hosts.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.claude.connected || !evidence.codex.configAccepted) process.exitCode = 1;
} finally { await broker.close(); }
