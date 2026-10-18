import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { requireResourceBudget } from "../src/resource-budget";

// Check the installed managed broker without launching any application or browser.
await requireResourceBudget();
const launcher = process.argv[2], output = process.argv[3];
if (!launcher || !output) throw new Error("Usage: installed-desktop-smoke.ts LAUNCHER REPORT.json");
const installedLauncher = resolve(launcher);
type Reply = { ok: boolean; result?: Record<string, unknown>; error?: { code?: string } };
async function invoke(args: string[], expectedCode?: string): Promise<Reply> {
  const child = Bun.spawn([installedLauncher, ...args], {
    stdout: "pipe", stderr: "pipe", timeout: 30000,
    env: { ...process.env, ORBIT_AGENT_NAME: "installation-test", ORBIT_TASK_NAME: "installed desktop contracts" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const reply: Reply = JSON.parse(code === 0 ? stdout : stderr);
  if (expectedCode ? code === 0 || reply.ok || reply.error?.code !== expectedCode : code !== 0 || !reply.ok)
    throw new Error(`Installed desktop command failed: ${args[0]}, ${reply.error?.code ?? code}`);
  return reply;
}
const doctor = await invoke(["doctor"]);
if (doctor.result?.sessionMode !== "desktop-only" || doctor.result?.backend !== "system")
  throw new Error("Installed broker did not report desktop-only routing");
const applications = await invoke(["applications", "orbit-missing-app-fixture"]);
if (applications.result?.scope !== "current-user" || !Array.isArray(applications.result.applications))
  throw new Error("Installed application discovery contract failed");
await invoke(["session", "create", "browser"], "UNSUPPORTED");
// `preview` prints the tokened loopback viewer link and opens nothing.
const viewer = await invoke(["preview"]);
if (typeof viewer.result?.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f-]{64,}$/.test(viewer.result.url))
  throw new Error("Installed viewer link contract failed");
const report = { ok: true, platform: process.platform,
  checks: ["managed broker", "installed launcher", "desktop health", "application discovery", "retired browser refusal", "session viewer link"],
  nativeApplicationControl: "not measured", browserLaunches: 0,
  limit: "installation and metadata contracts only; no native application acceptance" };
await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
