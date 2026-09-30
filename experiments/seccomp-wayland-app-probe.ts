import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Sessions } from "../src/session";
import { FedoraBackend } from "../src/fedora";
import { requireResourceBudget } from "../src/resource-budget";

// Opt-in, disposable real GTK client on an owned compositor. No personal app
// profile is read or copied. The experimental broker is not deployed to Orbit.
if (process.env.ORBIT_WAYLAND_BROKER_PROBE !== "1") throw new Error("Set ORBIT_WAYLAND_BROKER_PROBE=1 for the owned GTK experiment");
await requireResourceBudget();
const control = process.env.ORBIT_WAYLAND_BROKER_CONTROL === "1";
const gtk4 = process.env.ORBIT_WAYLAND_BROKER_GTK4 === "1";
const privateBus = process.env.ORBIT_WAYLAND_BROKER_BUS === "1";
const title = control ? "Orbit direct Wayland control" : "Orbit brokered Wayland application";
const description = control ? "Direct private display control without the experimental broker" : "Real GTK client through the experimental socket broker";
const root = await mkdtemp("/var/tmp/orbit-wayland-broker-");
const sessions = new Sessions(join(root, "workspace"));
const binary = join(root, "broker");
const script = join(root, "window.py");
const typed = join(root, "typed.txt");
const imageReport = join(root, "image.json");
const busReport = join(root, "bus.json");
const blockedSocket = join(root, "blocked.sock"), blockedReport = join(root, "blocked.json");
const output = resolve(`output/seccomp-wayland-app-${gtk4 ? "gtk4-" : ""}${privateBus ? "bus-" : ""}${control ? "control-" : ""}` + new Date().toISOString().slice(0, 10));
const phrase = control ? "Orbit direct Wayland control verified" : "Orbit brokered Wayland keyboard verified";
let clientProcess: ReturnType<typeof Bun.spawn> | undefined;
let blockedAccepts = 0;
const blockedServer = createServer(socket => { blockedAccepts++; socket.destroy(); });
try {
  await new Promise<void>((ready, fail) => {
    blockedServer.once("error", fail);
    blockedServer.listen(blockedSocket, () => { blockedServer.off("error", fail); ready(); });
  });
  await mkdir(output, { recursive: true, mode: 0o700 });
  const compiler = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const compilerErrors = await new Response(compiler.stderr).text();
  if (await compiler.exited !== 0) throw new Error(compilerErrors);
  await writeFile(script, `import gi,sys,socket,json
client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
client.settimeout(3)
blocked={"connected":False,"errno":None}
try:
    client.connect(sys.argv[2])
    blocked["connected"]=True
except OSError as error:
    blocked["errno"]=error.errno
finally:
    client.close()
with open(sys.argv[3],"w") as result: json.dump(blocked,result)
gi.require_version("Gtk",${JSON.stringify(gtk4 ? "4.0" : "3.0")})
from gi.repository import Gtk,GLib
from gi.repository import Gio
bus={"connected":False,"getId":False,"error":None}
try:
    connection=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    bus["connected"]=True
    reply=connection.call_sync("org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","GetId",None,GLib.VariantType.new("(s)"),Gio.DBusCallFlags.NONE,3000,None)
    bus["getId"]=len(reply.unpack()[0])==32
except GLib.Error as error:
    bus["error"]=error.message
with open(sys.argv[5],"w") as result: json.dump(bus,result)
window=Gtk.Window(title=${JSON.stringify(title)})
window.set_default_size(720,${gtk4 ? 440 : 240})
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=24)
${gtk4 ? `for edge in ["top","bottom","start","end"]: getattr(box,"set_margin_"+edge)(32)
box.append(Gtk.Label(label=${JSON.stringify(description)}))` : `box.set_border_width(32)
box.pack_start(Gtk.Label(label=${JSON.stringify(description)}),False,False,0)`}
entry=Gtk.Entry()
entry.connect("changed",lambda item:open(sys.argv[1],"w").write(item.get_text()))
${gtk4 ? `box.append(entry)
import cairo
image_path=sys.argv[4]+".png"
surface=cairo.ImageSurface(cairo.FORMAT_ARGB32,240,120)
context=cairo.Context(surface)
for x,color in [(0,(0.1,0.7,0.3)),(120,(0.1,0.3,0.9))]:
    context.set_source_rgb(*color)
    context.rectangle(x,0,120,120)
    context.fill()
surface.write_to_png(image_path)
picture=Gtk.Picture.new_for_filename(image_path)
picture.set_size_request(240,120)
box.append(picture)
def record_image():
    paintable=picture.get_paintable()
    with open(sys.argv[4],"w") as result:
        json.dump({"loaded":paintable is not None,"width":paintable.get_intrinsic_width() if paintable else 0,"height":paintable.get_intrinsic_height() if paintable else 0},result)
    return False
GLib.timeout_add(2500,record_image)
window.set_child(box)
loop=GLib.MainLoop()
window.connect("close-request",lambda item:(loop.quit(),False)[1])
window.present()
entry.grab_focus()
GLib.timeout_add(18000,lambda:(loop.quit(),False)[1])
loop.run()` : `box.pack_start(entry,False,False,0)
window.add(box)
window.connect("destroy",Gtk.main_quit)
window.show_all()
entry.grab_focus()
GLib.timeout_add(18000,lambda:(Gtk.main_quit(),False)[1])
Gtk.main()`}
`, { mode: 0o600 });
  const created = await sessions.dispatch({ method: "session.create", params: { backend: "fedora", agentName: "Codex",
    taskName: "Real GTK client over the experimental Wayland broker", projectName: "sbar-orbit",
    policy: { mode: "autonomous", origins: [], allow: ["read", "write"] } } }) as { sessionId: string };
  const registry = sessions as unknown as { sessions: Map<string, { backend: unknown }> };
  const backend = registry.sessions.get(created.sessionId)?.backend;
  if (!(backend instanceof FedoraBackend)) throw new Error("Missing owned native backend");
  // Access only this experiment's private environment, never the host display.
  const env: NodeJS.ProcessEnv = { ...(backend as unknown as { env: NodeJS.ProcessEnv }).env, GDK_BACKEND: "wayland" };
  const runtime = env.XDG_RUNTIME_DIR, display = env.WAYLAND_DISPLAY;
  if (!runtime?.startsWith("/tmp/orbit-native-") || !display?.match(/^wayland-[0-9]+$/))
    throw new Error("Missing private Wayland endpoint");
  const busPath = join(runtime, "bus");
  if (privateBus && env.DBUS_SESSION_BUS_ADDRESS !== `unix:path=${busPath}`)
    throw new Error("Missing owned private session bus");
  const app = ["/usr/bin/python3", script, typed, blockedSocket, blockedReport, imageReport, busReport];
  const launched = Bun.spawn(control ? app : [binary, join(runtime, display),
    ...(privateBus ? ["--bus", busPath] : []), ...app], { env, stdout: "pipe", stderr: "pipe" });
  clientProcess = launched;
  const standard = new Response(launched.stdout).text();
  const errors = new Response(launched.stderr).text();
  let visible = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await backend.presence()).title === title) { visible = true; break; }
    if (launched.exitCode !== null) break;
    await Bun.sleep(250);
  }
  let textVerified = false;
  if (visible) {
    await sessions.dispatch({ method: "session.act", params: { sessionId: created.sessionId, requestId: crypto.randomUUID(),
      action: { type: "text", text: phrase } } });
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await readFile(typed, "utf8").catch(() => "") === phrase) { textVerified = true; break; }
      await Bun.sleep(100);
    }
    const frame = await backend.observe();
    await writeFile(join(output, "brokered-gtk.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });
  }
  const exit = await launched.exited;
  const stdout = await standard, stderr = await errors;
  // Disposable app and transport errors only; this run has no account content.
  await writeFile(join(output, "stderr.txt"), stderr, { mode: 0o600 });
  const line = stdout.trim().split("\n").at(-1);
  const broker = line ? JSON.parse(line) : null;
  const blockedAttempt: unknown = JSON.parse(await readFile(blockedReport, "utf8"));
  const image: unknown = gtk4 ? JSON.parse(await readFile(imageReport, "utf8").catch(() => "null")) : null;
  const bus: unknown = JSON.parse(await readFile(busReport, "utf8").catch(() => "null"));
  const report = { date: new Date().toISOString().slice(0, 10), transport: control ? "direct-control" : "brokered",
    toolkit: gtk4 ? "GTK4" : "GTK3", privateBus, bus, visible, textVerified, image, exit, broker, blockedAttempt, blockedAccepts,
    limits: ["The launcher is experimental and not the production session launch action.",
      "No account state, existing conversations, files or device use was tested.",
      "Full outbound isolation and application compatibility remain unproved."] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, artifactDirectory: output }, null, 2));
} finally {
  if (clientProcess && clientProcess.exitCode === null) { clientProcess.kill("SIGTERM"); await clientProcess.exited; }
  await new Promise<void>(ready => blockedServer.close(() => ready()));
  await sessions.close();
  await rm(root, { recursive: true, force: true });
}
