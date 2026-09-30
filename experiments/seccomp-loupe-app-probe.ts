import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Sessions } from "../src/session";
import { FedoraBackend } from "../src/fedora";
import { requireResourceBudget } from "../src/resource-budget";

// Installed Loupe, owned display and generated image only. No personal profile.
if (process.env.ORBIT_LOUPE_BROKER_PROBE !== "1") throw new Error("Set ORBIT_LOUPE_BROKER_PROBE=1");
await requireResourceBudget();
const control = process.env.ORBIT_LOUPE_BROKER_CONTROL === "1";
const details = process.env.ORBIT_LOUPE_BROKER_DETAILS === "1";
const audit = process.env.ORBIT_LOUPE_BROKER_AUDIT === "1";
const loopback = process.env.ORBIT_LOUPE_BROKER_LOOPBACK === "1";
const root = await mkdtemp("/var/tmp/orbit-loupe-broker-");
const sessions = new Sessions(join(root, "workspace"));
const output = resolve(`output/seccomp-loupe-${loopback ? "loopback-" : ""}${control ? "control-" : ""}` + new Date().toISOString().slice(0, 10));
const image = join(root, "orbit-generated-halves.png"), binary = join(root, "broker");
let client: ReturnType<typeof Bun.spawn> | undefined;
try {
  await mkdir(output, { recursive: true, mode: 0o700 });
  if (!await Bun.file("/usr/bin/loupe").exists()) throw new Error("Installed Loupe is absent");
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const compileErrors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(compileErrors);
  const generate = Bun.spawn(["/usr/bin/python3", "-c", `import cairo,sys
surface=cairo.ImageSurface(cairo.FORMAT_ARGB32,600,360)
context=cairo.Context(surface)
for x,color in [(0,(0.1,0.7,0.3)),(300,(0.1,0.3,0.9))]:
    context.set_source_rgb(*color)
    context.rectangle(x,0,300,360)
    context.fill()
surface.write_to_png(sys.argv[1])`, image], { stdout: "pipe", stderr: "pipe" });
  if (await generate.exited !== 0) throw new Error(await new Response(generate.stderr).text());
  const created = await sessions.dispatch({ method: "session.create", params: { backend: "fedora", agentName: "Codex",
    taskName: "Installed Loupe over the experimental Wayland broker", projectName: "sbar-orbit",
    policy: { mode: "autonomous", origins: [], allow: ["read", "write"] } } }) as { sessionId: string };
  const registry = sessions as unknown as { sessions: Map<string, { backend: unknown }> };
  const backend = registry.sessions.get(created.sessionId)?.backend;
  if (!(backend instanceof FedoraBackend)) throw new Error("Missing owned native backend");
  const env: NodeJS.ProcessEnv = { ...(backend as unknown as { env: NodeJS.ProcessEnv }).env, GDK_BACKEND: "wayland" };
  if (audit) env.ORBIT_PRIVATE_BROKER_AUDIT = "1";
  if (loopback) env.ORBIT_PRIVATE_BROKER_LOOPBACK = "1";
  const runtime = env.XDG_RUNTIME_DIR, display = env.WAYLAND_DISPLAY;
  if (!runtime?.startsWith("/tmp/orbit-native-") || !display?.match(/^wayland-[0-9]+$/) ||
      env.DBUS_SESSION_BUS_ADDRESS !== `unix:path=${join(runtime, "bus")}` ||
      !env.XDG_CONFIG_HOME?.startsWith(runtime + "/") || !env.XDG_DATA_HOME?.startsWith(runtime + "/"))
    throw new Error("Missing owned private application environment");
  const app = ["/usr/bin/loupe", image];
  const launched = Bun.spawn(control ? app : [binary, join(runtime, display), "--bus-credentials", join(runtime, "bus"), ...app],
    { env, stdout: "pipe", stderr: "pipe" });
  client = launched;
  const stdout = new Response(launched.stdout).text(), stderr = new Response(launched.stderr).text();
  let visible = false, title = "";
  let renderedColors: unknown = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const presence = await backend.presence();
    if (presence.pageCount > 0) { visible = true; title = presence.title; break; }
    if (client.exitCode !== null) break;
    await Bun.sleep(250);
  }
  if (visible) {
    await Bun.sleep(3000);
    const frame = await backend.observe();
    await writeFile(join(output, "loupe.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });
    const pixels = Bun.spawn(["/usr/bin/python3", "-c", `from PIL import Image
import sys,json
image=Image.open(sys.argv[1]).convert("RGB")
left=image.getpixel((480,400)); right=image.getpixel((800,400))
print(json.dumps({"left":left,"right":right,"matched":left[0]<70 and left[1]>150 and left[2]<130 and right[0]<70 and right[1]<130 and right[2]>180}))`, join(output, "loupe.jpg")], { stdout: "pipe", stderr: "pipe" });
    const pixelOutput = await new Response(pixels.stdout).text();
    if (await pixels.exited !== 0) throw new Error(await new Response(pixels.stderr).text());
    renderedColors = JSON.parse(pixelOutput);
    if (details && !control) {
      // The preceding owned frame locates Loupe's More Information button.
      await backend.control({ type: "click", x: 640, y: 535 });
      await Bun.sleep(500);
      const information = await backend.observe();
      await writeFile(join(output, "loupe-details.jpg"), Buffer.from(information.image, "base64"), { mode: 0o600 });
    }
    await sessions.dispatch({ method: "session.act", params: { sessionId: created.sessionId, requestId: crypto.randomUUID(),
      action: { type: "window", command: "close" } } });
    if (details && !control) {
      await Bun.sleep(150);
      if ((await backend.presence()).pageCount > 0)
        await sessions.dispatch({ method: "session.act", params: { sessionId: created.sessionId, requestId: crypto.randomUUID(),
          action: { type: "window", command: "close" } } });
    }
  }
  let forcedStop = false;
  for (let attempt = 0; attempt < 50 && client.exitCode === null; attempt++) await Bun.sleep(100);
  if (client.exitCode === null) { forcedStop = true; client.kill("SIGTERM"); }
  const exit = await client.exited;
  const text = await stdout, errors = await stderr;
  await writeFile(join(output, "stderr.txt"), errors, { mode: 0o600 });
  const lastLine = text.trim().split("\n").at(-1);
  const broker: unknown = control || !lastLine ? null : JSON.parse(lastLine);
  const report = { date: new Date().toISOString().slice(0, 10), application: "Installed /usr/bin/loupe",
    transport: control ? "direct-control" : "brokered", audit, details, loopback, visible, title, exit, forcedStop, broker,
    renderedColors,
    limits: ["Experimental launch, not the production session action.", "Generated file and disposable application state only.",
      "No current accounts, conversations, personal files or devices were measured.",
      ...(!control ? ["The brokered private bus reports broker PID, not application PID."] : [])] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, artifactDirectory: output }, null, 2));
} finally {
  if (client && client.exitCode === null) { client.kill("SIGTERM"); await client.exited; }
  await sessions.close();
  await rm(root, { recursive: true, force: true });
}
