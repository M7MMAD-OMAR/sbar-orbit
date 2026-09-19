import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { agentHosts, hostConfigPath, type HostEntry } from "../src/host-registration";

// Real host CLIs, disposable configuration, and no model requests or credentials.
await requireResourceBudget();
const root = await mkdtemp(join(tmpdir(), "orbit-host-acceptance-"));
const source = resolve(import.meta.dir, "..");
const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_HOME: join(root, "codex"), HERMES_HOME: join(root, "hermes"),
  XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "appdata") };
async function command(argv: string[], cwd = root) {
  const child = Bun.spawn(argv, { env, cwd, stdout: "pipe", stderr: "pipe", timeout: 45000 });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, exit };
}
try {
  await mkdir(env.CODEX_HOME, { recursive: true });
  const installer = join(source, process.platform === "win32" ? "install.cmd" : "install.sh");
  const install = await command([installer, "--no-service", "--connect", "claude,codex,hermes", "--prefix", join(root, "prefix"), "--json"], source);
  if (install.exit !== 0) throw new Error(`Installation failed: exit ${install.exit}`);
  const report = JSON.parse(install.out);
  const registration = report.steps.find((step: { id: string }) => step.id === "hosts")?.data?.registration;
  if (!Array.isArray(registration) || registration.some(row => row.state !== "configured")) throw new Error("Hosts were not registered");
  for (const host of agentHosts) {
    const text = await readFile(hostConfigPath(host, env), "utf8");
    const parsed = host === "codex" ? Bun.TOML.parse(text) : host === "hermes" ? Bun.YAML.parse(text) : JSON.parse(text);
    const entry = (parsed as Record<string, Record<string, HostEntry>>)[host === "claude" ? "mcpServers" : "mcp_servers"]?.orbit;
    if (!entry) throw new Error(`No registered entry for ${host}`);
    const client = new Client({ name: "orbit-registration-acceptance", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ ...entry, stderr: "pipe" }));
      const names = (await client.listTools()).tools.map(tool => tool.name);
      if (!names.includes("orbit_create") || !names.includes("orbit_observe")) throw new Error("Missing Orbit tools");
      console.log(JSON.stringify({ host, ok: true, scope: "registered entry negotiates MCP", tools: names.length }));
    } finally { await client.close(); }
  }
  const checks = [
    { host: "claude", args: ["mcp", "get", "orbit"], evidence: /Connected|connected/ },
    { host: "codex", args: ["mcp", "get", "orbit", "--json"], evidence: /ORBIT_SOCKET/ },
    { host: "hermes", args: ["mcp", "test", "orbit"], evidence: /orbit_create/ },
  ];
  for (const check of checks) {
    const executable = Bun.which(check.host);
    if (!executable) { console.log(JSON.stringify({ host: check.host, state: "not measured", reason: "CLI absent" })); continue; }
    const result = await command([executable, ...check.args]);
    const ok = result.exit === 0 && check.evidence.test(result.out + result.err);
    console.log(JSON.stringify({ host: check.host, ok, exit: result.exit,
      scope: check.host === "codex" ? "native CLI reads registered entry" : "native CLI connects to Orbit MCP" }));
    if (!ok) throw new Error(`${check.host} did not confirm registration (stdout ${result.out.length} bytes, stderr ${result.err.length} bytes)`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
