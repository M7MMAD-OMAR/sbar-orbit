import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Sessions } from "../src/session";
import { FedoraBackend } from "../src/fedora";
import { requireResourceBudget } from "../src/resource-budget";

if (process.env.ORBIT_NEXTCLOUD_BROKER_PROBE !== "1") throw new Error("Set ORBIT_NEXTCLOUD_BROKER_PROBE=1");
await requireResourceBudget();
const control = process.env.ORBIT_NEXTCLOUD_BROKER_CONTROL === "1";
const software = process.env.ORBIT_NEXTCLOUD_BROKER_SOFTWARE === "1";
const network = process.env.ORBIT_NEXTCLOUD_BROKER_NETWORK === "1";
const tcp = process.env.ORBIT_NEXTCLOUD_BROKER_TCP === "1";
if (tcp && !network) throw new Error("TCP mode requires the owned network fixture");
const requests: { method: string; path: string }[] = [];
const fixture = network ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push({ method: request.method, path });
  if (path === "/status.php") return Response.json({ installed: true, maintenance: false, needsDbUpgrade: false,
    version: "32.0.0.0", versionstring: "32.0.0", edition: "", productname: "Nextcloud", extendedSupport: false });
  // Never return a login URL, token or redirect that could launch a browser.
  return Response.json({ error: "Disposable Orbit discovery fixture. Authentication is disabled." }, { status: 503 });
} }) : undefined;
const root = await mkdtemp("/var/tmp/orbit-nextcloud-broker-");
const sessions = new Sessions(join(root, "workspace"));
const output = resolve(`output/seccomp-nextcloud-${network ? "network-" : ""}${tcp ? "tcp-" : ""}${software ? "software-" : ""}${control ? "control-" : ""}` + new Date().toISOString().slice(0, 10));
const binary = join(root, "broker"), home = join(root, "home"), config = join(root, "nextcloud-config");
async function nextcloudProcesses(): Promise<number[]> {
  const processList = Bun.spawn(["pgrep", "-x", "nextcloud"], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(processList.stdout).text();
  const exit = await processList.exited;
  if (exit !== 0 && exit !== 1) throw new Error("Could not inventory Nextcloud process IDs");
  return text.trim().split("\n").filter(Boolean).map(Number);
}
const originalProcesses = await nextcloudProcesses();
let client: ReturnType<typeof Bun.spawn> | undefined;
try {
  await mkdir(output, { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  if (!await Bun.file("/usr/bin/nextcloud").exists()) throw new Error("Installed Nextcloud is absent");
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const compileErrors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(compileErrors);
  const created = await sessions.dispatch({ method: "session.create", params: { backend: "fedora", agentName: "Codex",
    taskName: "Installed Nextcloud over the experimental private broker", projectName: "sbar-orbit",
    policy: { mode: "autonomous", origins: [], allow: ["read", "write"] } } }) as { sessionId: string };
  const registry = sessions as unknown as { sessions: Map<string, { backend: unknown }> };
  const backend = registry.sessions.get(created.sessionId)?.backend;
  if (!(backend instanceof FedoraBackend)) throw new Error("Missing owned native backend");
  const env: NodeJS.ProcessEnv = { ...(backend as unknown as { env: NodeJS.ProcessEnv }).env,
    HOME: home, QT_QPA_PLATFORM: "wayland", ORBIT_PRIVATE_BROKER_AUDIT: "1",
    ORBIT_PRIVATE_BROKER_PAIRS: "1", ORBIT_PRIVATE_BROKER_LOOPBACK: "1" };
  const runtime = env.XDG_RUNTIME_DIR, display = env.WAYLAND_DISPLAY;
  if (software) env.QT_QUICK_BACKEND = "software";
  if (tcp && fixture) env.ORBIT_PRIVATE_BROKER_TCP_PORT = String(fixture.port);
  else delete env.ORBIT_PRIVATE_BROKER_TCP_PORT;
  if (!runtime?.startsWith("/tmp/orbit-native-") || !display?.match(/^wayland-[0-9]+$/) ||
      env.DBUS_SESSION_BUS_ADDRESS !== `unix:path=${join(runtime, "bus")}` ||
      !env.XDG_CONFIG_HOME?.startsWith(runtime + "/") || !env.XDG_DATA_HOME?.startsWith(runtime + "/"))
    throw new Error("Missing owned private application environment");
  const app = ["/usr/bin/nextcloud", "--confdir", config, "--logfile", join(output, "application.log"), "--logflush"];
  const launched = Bun.spawn(control ? app : [binary, join(runtime, display), "--bus-credentials", join(runtime, "bus"), ...app],
    { env, stdout: "pipe", stderr: "pipe" });
  client = launched;
  const stdout = new Response(launched.stdout).text(), stderr = new Response(launched.stderr).text();
  let visible = false, title = "";
  let startupFrameSha256: string | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const presence = await backend.presence();
    if (presence.pageCount > 0) { visible = true; title = presence.title; break; }
    if (launched.exitCode !== null) break;
    await Bun.sleep(250);
  }
  if (visible) {
    await Bun.sleep(8000);
    const frame = await backend.observe();
    const pixels = Buffer.from(frame.image, "base64");
    startupFrameSha256 = createHash("sha256").update(pixels).digest("hex");
    await writeFile(join(output, "nextcloud.jpg"), pixels, { mode: 0o600 });
    if (fixture) {
      // The observed setup frame locates the empty server field and Log in.
      await backend.control({ type: "click", x: 400, y: 135 });
      await Bun.sleep(250);
      await backend.control({ type: "text", text: `http://127.0.0.1:${fixture.port}` });
      await Bun.sleep(250);
      const entered = await backend.observe();
      await writeFile(join(output, "nextcloud-entered.jpg"), Buffer.from(entered.image, "base64"), { mode: 0o600 });
      await backend.control({ type: "click", x: 1205, y: 135 });
      await Bun.sleep(5000);
      if (control || tcp) {
        const tlsFrame = await backend.observe();
        await writeFile(join(output, "nextcloud-tls.jpg"), Buffer.from(tlsFrame.image, "base64"), { mode: 0o600 });
        // The observed direct control prompts to retry this credential-free
        // loopback fixture without TLS. Never apply this to a real account.
        await backend.control({ type: "click", x: 640, y: 463 });
        await Bun.sleep(2000);
      }
      const networkFrame = await backend.observe();
      await writeFile(join(output, "nextcloud-network.jpg"), Buffer.from(networkFrame.image, "base64"), { mode: 0o600 });
    }
    await sessions.dispatch({ method: "session.act", params: { sessionId: created.sessionId, requestId: crypto.randomUUID(),
      action: { type: "window", command: "close" } } });
  }
  let scopedStop = false;
  for (let attempt = 0; attempt < 20 && launched.exitCode === null; attempt++) await Bun.sleep(100);
  if (launched.exitCode === null) { scopedStop = true; launched.kill("SIGTERM"); }
  const exit = await launched.exited, text = await stdout, errors = await stderr;
  await writeFile(join(output, "stderr.txt"), errors, { mode: 0o600 });
  const lastLine = text.trim().split("\n").at(-1);
  const broker: unknown = control || !lastLine ? null : JSON.parse(lastLine);
  const finalProcesses = await nextcloudProcesses();
  const report = { date: new Date().toISOString().slice(0, 10), application: "Installed /usr/bin/nextcloud",
    transport: control ? "direct-control" : "brokered", software, network, tcp, visible, title, exit, scopedStop, broker,
    startupFrameSha256, fixtureRequests: requests, discoveryObserved: requests.some(request => request.path === "/status.php"),
    originalProcessCount: originalProcesses.length, originalProcessesStillPresent: originalProcesses.every(pid => finalProcesses.includes(pid)),
    limits: ["Disposable home and configuration only; existing native account state was not copied or measured.",
      "Experimental launch outside the production session action.", "No personal sync folders or credentials were read.",
      "Window presence alone does not prove functional setup or networking."] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, artifactDirectory: output }, null, 2));
} finally {
  if (client && client.exitCode === null) { client.kill("SIGTERM"); await client.exited; }
  await sessions.close();
  fixture?.stop(true);
  await rm(root, { recursive: true, force: true });
}
