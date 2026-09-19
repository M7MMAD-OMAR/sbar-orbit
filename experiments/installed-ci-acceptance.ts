// Fresh managed installation on disposable CI hosts only. This changes user services.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Requires a disposable GitHub Actions runner");
const source = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "orbit installed acceptance "));
const prefix = join(root, "prefix");
const output = join(source, "output/installed-acceptance");
await mkdir(output, { recursive: true });
const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_HOME: join(root, "codex"), HERMES_HOME: join(root, "hermes") };
await mkdir(env.CODEX_HOME, { recursive: true });
const installer = join(source, process.platform === "win32" ? "install.cmd" : "install.sh");
const child = Bun.spawn([installer, "--prefix", prefix, "--connect", "claude,codex,hermes", "--json"],
  { cwd: source, env, stdout: "pipe", stderr: "pipe", timeout: 180000 });
const [out, err, exit] = await Promise.all([
  new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
]);
await writeFile(join(output, "installer.json"), out);
await writeFile(join(output, "installer.stderr.txt"), err);
if (exit !== 0) throw new Error(`Managed installation failed with exit ${exit}; see installer artifacts`);
const report = JSON.parse(out);
if (report.installed !== true) throw new Error("Installer did not report a usable installation");
const hosts = report.steps.find((step: { id: string }) => step.id === "hosts")?.data?.registration;
if (!Array.isArray(hosts) || hosts.length !== 3 || hosts.some(row => row.state !== "configured")) {
  throw new Error("The one-command installation did not configure all three requested hosts");
}
const launcher = join(prefix, "bin", process.platform === "win32" ? "sbar-orbit.cmd" : "sbar-orbit");
const smoke = Bun.spawn([process.execPath, "run", "scripts/limited.ts", process.execPath,
  "experiments/installed-browser-smoke.ts", launcher, join(output, "browser.jpg")],
  { cwd: source, env, stdout: "inherit", stderr: "inherit", timeout: 120000 });
const smokeExit = await smoke.exited;
if (smokeExit !== 0) throw new Error(`Installed browser flow failed with exit ${smokeExit}`);
console.log(JSON.stringify({ installed: true, registeredHosts: hosts.length, browserFlow: "passed",
  limit: "disposable runner with Bun and dependencies provisioned; not physical desktop acceptance" }));
// Keep the prefix available for the managed service until the disposable runner is destroyed.
