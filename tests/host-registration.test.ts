import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolvedTmpdir } from "./platform-support";
import { addHostEntry, agentHosts, hostConfigPath, parseHosts, registerAgentHosts } from "../src/host-registration";

const entry = { command: "/a path/أوربت/bun", args: ["/a path/mcp.ts"], env: { ORBIT_SOCKET: "/a path/broker.sock" } };
const samples = {
  claude: JSON.stringify({ theme: "dark", mcpServers: { neighbour: { command: "keep-me" } } }),
  codex: '# keep this comment\nmodel = "example"\n[mcp_servers.neighbour]\ncommand = "keep-me"\n',
  hermes: 'model: example\nmcp_servers:\n  neighbour:\n    command: keep-me\n',
};
test("Hermes uses its native Windows home and respects an explicit profile", () => {
  expect(hostConfigPath("hermes", { LOCALAPPDATA: "C:\\profile\\Local" }, "C:\\profile", "win32"))
    .toBe("C:\\profile\\Local\\hermes\\config.yaml");
  expect(hostConfigPath("hermes", { HERMES_HOME: "D:\\profiles\\work" }, "C:\\profile", "win32"))
    .toBe("D:\\profiles\\work\\config.yaml");
});
for (const host of agentHosts) {
  test(`${host}: preserve neighbours, quote paths and repeat without changing bytes`, () => {
    const added = addHostEntry(host, samples[host], entry);
    const parsed = host === "codex" ? Bun.TOML.parse(added.text) : host === "hermes" ? Bun.YAML.parse(added.text) : JSON.parse(added.text);
    const servers = (parsed as Record<string, any>)[host === "claude" ? "mcpServers" : "mcp_servers"];
    expect(servers.neighbour.command).toBe("keep-me");
    expect(servers.orbit).toEqual(entry);
    expect(addHostEntry(host, added.text, entry)).toEqual({ changed: false, text: added.text });
    expect(() => addHostEntry(host, added.text, { ...entry, command: "foreign" })).toThrow("left unchanged");
    if (host === "codex") expect(added.text).toContain("# keep this comment");
  });
}

test("registration plans without writes, backs up existing settings and leaves conflicts intact", async () => {
  const root = await mkdtemp(join(await resolvedTmpdir(), "orbit-hosts-"));
  const options = { home: root, env: {}, which: () => null };
  try {
    for (const host of agentHosts) {
      const path = hostConfigPath(host, {}, root);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, samples[host]);
    }
    const planned = await registerAgentHosts("auto", entry, { ...options, dryRun: true });
    expect(planned.map(row => row.state)).toEqual(["planned", "planned", "planned"]);
    for (const host of agentHosts) expect(await readFile(hostConfigPath(host, {}, root), "utf8")).toBe(samples[host]);
    const written = await registerAgentHosts("auto", entry, options);
    expect(written.map(row => row.state)).toEqual(["configured", "configured", "configured"]);
    for (const row of written) {
      if (!row.backup) throw new Error("Missing backup");
      expect(await readFile(row.backup, "utf8")).toBe(samples[row.host]);
    }
    expect((await registerAgentHosts("auto", entry, options)).map(row => row.state)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect((await registerAgentHosts("auto", { ...entry, command: "other" }, options)).map(row => row.state)).toEqual(["failed", "failed", "failed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("absent hosts are skipped, explicit choices are planned, and invalid settings never leak", async () => {
  const root = await mkdtemp(join(await resolvedTmpdir(), "orbit-hosts-"));
  const options = { home: root, env: {}, which: () => null };
  try {
    expect((await registerAgentHosts("auto", entry, options)).every(row => row.state === "not-found")).toBe(true);
    expect(await readdir(root)).toEqual([]);
    expect((await registerAgentHosts(["claude"], entry, { ...options, dryRun: true }))[0]?.state).toBe("planned");
    const path = hostConfigPath("claude", {}, root);
    await writeFile(path, '{"private":"DO_NOT_ECHO", broken');
    const result = await registerAgentHosts(["claude"], entry, options);
    expect(result[0]?.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("DO_NOT_ECHO");
    expect(await readFile(path, "utf8")).toContain("DO_NOT_ECHO");
    expect(parseHosts("claude,codex,claude")).toEqual(["claude", "codex"]);
    expect(() => parseHosts("unknown")).toThrow("--connect");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hermes registration follows its active profile without changing the default profile", async () => {
  const root = await mkdtemp(join(await resolvedTmpdir(), "orbit-active-host-"));
  const defaultPath = hostConfigPath("hermes", {}, root);
  const base = join(defaultPath, "..");
  try {
    await mkdir(base, { recursive: true });
    await writeFile(defaultPath, samples.hermes);
    await writeFile(join(base, "active_profile"), "work\n");
    const result = await registerAgentHosts(["hermes"], entry, { home: root, env: {}, which: () => null });
    expect(result[0]?.state).toBe("configured");
    expect(result[0]?.path).toBe(join(base, "profiles", "work", "config.yaml"));
    expect(await readFile(defaultPath, "utf8")).toBe(samples.hermes);
    await writeFile(join(base, "active_profile"), "../../outside");
    expect((await registerAgentHosts(["hermes"], entry, { home: root, env: {} }))[0]?.state).toBe("failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
