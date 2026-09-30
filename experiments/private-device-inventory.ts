import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Sessions } from "../src/session";
import { requireResourceBudget } from "../src/resource-budget";

// No microphone/camera capture, playback or graph mutation. The optional camera
// query opens nodes only long enough to read capabilities, never starts a stream.
if (process.env.ORBIT_DEVICE_INVENTORY !== "1") throw new Error("Set ORBIT_DEVICE_INVENTORY=1 for private device enumeration");
await requireResourceBudget();
const root = await mkdtemp("/var/tmp/orbit-device-inventory-");
const sessions = new Sessions(join(root, "workspace"));
const script = join(root, "inventory.py");
const result = join(root, "result.json");
const cameraQuery = process.env.ORBIT_CAMERA_QUERY === "1";
const output = resolve(`output/private-device-${cameraQuery ? "query" : "inventory"}-` + new Date().toISOString().slice(0, 10));
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(result, "", { mode: 0o600 });
await writeFile(script, `import glob,json,subprocess,sys,os,fcntl,struct
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
report={"videoNodes":len(glob.glob("/dev/video[0-9]*"))}
for category in ("sinks","sources"):
    try:
        process=subprocess.run(["/usr/bin/pactl","--format=json","list",category],capture_output=True,timeout=5)
        items=json.loads(process.stdout) if process.returncode==0 else []
        report[category]={"enumerated":process.returncode==0,"count":len(items)}
    except Exception:
        report[category]={"enumerated":False,"count":0}
if sys.argv[2]=="query":
    nodes=[]
    for path in sorted(glob.glob("/dev/video[0-9]*")):
        item={"opened":False,"queried":False}
        fd=None
        try:
            fd=os.open(path,os.O_RDWR|os.O_NONBLOCK|os.O_CLOEXEC)
            item["opened"]=True
            caps=bytearray(104)
            # Installed linux/videodev2.h: VIDIOC_QUERYCAP, 104-byte capability struct.
            fcntl.ioctl(fd,0x80685600,caps,True)
            capabilities,device_caps=struct.unpack_from("=II",caps,84)
            bits=device_caps if capabilities&0x80000000 else capabilities
            item.update(queried=True,videoCapture=bool(bits&0x1001),
                metadataCapture=bool(bits&0x00800000),streamingSupported=bool(bits&0x04000000))
        except OSError as error:
            item["errno"]=error.errno
        finally:
            if fd is not None: os.close(fd)
        nodes.append(item)
    report["cameraQuery"]=nodes
with open(sys.argv[1],"w") as stream: json.dump(report,stream)
window=Gtk.Window(title="Orbit private device inventory")
window.set_default_size(640,320)
label=Gtk.Label(label="Private display device enumeration\\n\\n"+
    "Audio outputs: "+str(report["sinks"]["count"])+"\\n"+
    "Audio inputs: "+str(report["sources"]["count"])+"\\n"+
    "Camera device nodes: "+str(report["videoNodes"])+"\\n\\n"+
    ("Camera capability queries: "+str(sum(item["queried"] for item in report["cameraQuery"]))+"\\n" if "cameraQuery" in report else "")+
    "No recording, playback or device settings changed")
window.add(label)
window.connect("destroy",Gtk.main_quit)
window.show_all()
Gtk.main()
`, { mode: 0o600 });
try {
  const hostVideoNodes = (await readdir("/dev")).filter(name => /^video[0-9]+$/.test(name)).length;
  const created = await sessions.dispatch({ method: "session.create", params: { backend: "fedora", agentName: "Codex",
    taskName: cameraQuery ? "Query private camera access" : "Enumerate private audio and camera devices", projectName: "sbar-orbit",
    policy: { mode: "autonomous", origins: [], allow: ["read", "write"] } } }) as { sessionId: string };
  await sessions.dispatch({ method: "session.act", params: { sessionId: created.sessionId, requestId: crypto.randomUUID(),
    action: { type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", script, result, cameraQuery ? "query" : "enumerate"], selectedFiles: [script, result] } } });
  let inventory: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    const text = await readFile(result, "utf8");
    if (text) { inventory = JSON.parse(text); break; }
    await Bun.sleep(250);
  }
  if (!inventory) throw new Error("Private inventory did not finish");
  let frame: { image: string; presence: { title: string } } | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = await sessions.dispatch({ method: "session.observe", params: { sessionId: created.sessionId } }) as NonNullable<typeof frame>;
    if (candidate.presence.title === "Orbit private device inventory") { frame = candidate; break; }
    await Bun.sleep(250);
  }
  if (!frame) throw new Error("Private inventory window was not visible");
  await writeFile(join(output, "private-devices.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });
  const report = { date: new Date().toISOString().slice(0, 10), hostVideoNodes, privateDisplay: inventory,
    windowVisible: true, limits: ["Enumeration and capability queries do not prove recording or playback.",
      cameraQuery ? "Video nodes were opened and queried without starting capture." : "No physical device was opened.",
      "No audio was recorded or played.", "Account application compatibility was not measured."] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, artifactDirectory: output }, null, 2));
} finally {
  await sessions.close();
  await rm(root, { recursive: true, force: true });
}
