// Fresh managed installation on disposable CI hosts only. This changes user services.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Requires a disposable GitHub Actions runner");
const checkout = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "orbit installed acceptance "));
const prefix = join(root, "prefix");
const output = join(checkout, "output/installed-acceptance");
await mkdir(output, { recursive: true });
const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_HOME: join(root, "codex"), HERMES_HOME: join(root, "hermes") };
await mkdir(env.CODEX_HOME, { recursive: true });
// Exercise the artifact users receive, without borrowing checkout dependencies.
// The isolated temporary parent also prevents Bun from resolving node_modules
// through the checkout's ancestors.
const pack = Bun.spawn([process.execPath, "scripts/registry-package.ts", root],
  { cwd: checkout, stdout: "ignore", stderr: "inherit" });
if (await pack.exited !== 0) throw new Error("Could not build registry archive");
const archives = (await readdir(root)).filter(name => name.endsWith(".tgz"));
const archive = archives[0];
if (archives.length !== 1 || !archive) throw new Error("Expected exactly one registry archive");
const extract = Bun.spawn(["tar", "xzf", join(root, archive), "-C", root],
  { stdout: "ignore", stderr: "inherit" });
if (await extract.exited !== 0) throw new Error("Could not extract registry archive");
const source = join(root, "package");
if (await Bun.file(join(source, "node_modules/playwright/package.json")).exists())
  throw new Error("Fresh package unexpectedly contains prepared dependencies");
const installer = join(source, process.platform === "win32" ? "install.cmd" : "install.sh");
const installArgs = ["--prefix", prefix, "--connect", "claude,codex,hermes", "--json"];
let installCommand = [installer, ...installArgs];
if (process.platform === "win32") {
  // Bun's implicit cmd.exe invocation splits a batch path containing spaces.
  // Invoke it through PowerShell as a person would, with literal arguments.
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const driver = join(root, "invoke-installer.ps1");
  await writeFile(driver, `& ${[installer, ...installArgs].map(quote).join(" ")}\nexit $LASTEXITCODE\n`);
  installCommand = [join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver];
}
const child = Bun.spawn(installCommand,
  { cwd: source, env, stdout: "pipe", stderr: "pipe", timeout: 180000 });
const [out, err, exit] = await Promise.all([
  new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
]);
await writeFile(join(output, "installer.json"), out);
await writeFile(join(output, "installer.stderr.txt"), err);
if (exit !== 0) throw new Error(`Managed installation failed with exit ${exit}; see installer artifacts`);
const report = JSON.parse(out);
if (report.installed !== true) throw new Error("Installer did not report a usable installation");
if (report.steps.find((step: { id: string }) => step.id === "dependencies")?.state !== "done")
  throw new Error("Fresh archive did not install its frozen project dependencies");
const hosts = report.steps.find((step: { id: string }) => step.id === "hosts")?.data?.registration;
if (!Array.isArray(hosts) || hosts.length !== 3 || hosts.some(row => row.state !== "configured")) {
  throw new Error("The one-command installation did not configure all three requested hosts");
}
const launcher = join(prefix, "bin", process.platform === "win32" ? "sbar-orbit.cmd" : "sbar-orbit");
const smoke = Bun.spawn([process.execPath, "run", "scripts/limited.ts", process.execPath,
  "experiments/installed-browser-smoke.ts", launcher, join(output, "browser.jpg")],
  { cwd: checkout, env, stdout: "inherit", stderr: "inherit", timeout: 120000 });
const smokeExit = await smoke.exited;
if (smokeExit !== 0) throw new Error(`Installed browser flow failed with exit ${smokeExit}`);
console.log(JSON.stringify({ installed: true, registeredHosts: hosts.length, browserFlow: "passed",
  limit: "registry archive with no prepared project dependencies; Bun and browser provisioned on disposable runner" }));
// Keep the prefix available for the managed service until the disposable runner is destroyed.
