import { startBroker } from "../src/ipc";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const hermes = process.env.ORBIT_HERMES_SOURCE ?? join(homedir(), ".hermes/hermes-agent");
const root = await mkdtemp(join(tmpdir(), "orbit-hermes-interface-"));
const broker = await startBroker();
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  '<!doctype html><title>Orbit interface fixture</title><h1>Private browser fixture</h1><p>Metadata and image delivery through Hermes.</p>',
  { headers: { "content-type": "text/html" } }) });
try {
  const child = Bun.spawn([join(hermes, "venv/bin/python"), join(import.meta.dir, "hermes-interface.py")], {
    env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      HERMES_HOME: root, ORBIT_USAGE_DIR: join(root, "usage"), ORBIT_HERMES_SOURCE: hermes,
      ORBIT_BUN: process.execPath, ORBIT_MCP_ENTRY: join(import.meta.dir, "../src/mcp.ts"),
      ORBIT_SOCKET: broker.socket, ORBIT_FIXTURE_URL: `http://127.0.0.1:${fixture.port}` },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Hermes probe failed (${code}): ${stderr}`);
    console.log(stdout.trim());
  } finally { clearTimeout(timer); }
} finally { await broker.close(); fixture.stop(true); await rm(root, { recursive: true, force: true }); }
