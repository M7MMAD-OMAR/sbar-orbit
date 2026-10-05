/** Compare the shipped private Fedora backend and current scoped backend in a guarded lab. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { FedoraBackend } from "../../src/fedora";
import { NativeBackend } from "../../src/hyprland";
import { requireResourceBudget, readCpuSample } from "../../src/resource-budget";
import { record } from "../../src/errors";

await requireResourceBudget();
const root = resolve(import.meta.dir, "../..");
const runtime = process.env.XDG_RUNTIME_DIR;
assert(runtime && /^\/(?:tmp|var\/tmp)\/gl-[A-Za-z0-9_-]+\/run$/.test(runtime));
assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${runtime}/bus`);
assert.equal(process.env.DISPLAY, undefined);
assert.equal(process.env.WAYLAND_SOCKET, undefined);
const lab = dirname(runtime);
const work = await mkdtemp(join(root, ".private/native-path-cost-"));
const control = join(lab, "cost-control");
const planPath = join(lab, "cost-host.json");
const sourceFiles = ["experiments/ghost-cursor/native_path_cost.ts", "experiments/fedora-display/fixture.py",
  "src/fedora.ts", "src/hyprland.ts", "src/native-worker.ts", "src/native/session_worker.py",
  ...["session", "application", "application_worker", "transport", "host", "lease", "control", "supervise", "budget"]
    .map(name => `src/native/${name}.py`),
  "src/resource-budget.ts", "src/viewport.ts", "src/runtime-paths.ts", "src/native-renderer.ts", "experiments/ghost-cursor/lab.py",
  "experiments/ghost-cursor/cursor_cost_probe.py", "experiments/ghost-cursor/plugin/ghostinput.cpp"];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name =>
  [name, new Bun.CryptoHasher("sha256").update(await readFile(join(root, name))).digest("hex")])));
const report: Record<string, unknown> = { complete: false, errors: [], cleanupErrors: [],
  scope: "Guarded backend path comparison; owner performance acceptance not measured",
  order: ["fedora", "native", "native", "fedora"], sourceSha256: await hashes(), rows: [],
  limitations: ["The current path uses an already-running private lab compositor; its baseline remains recorded.",
    "Previous output uses its shipped encoder; current output uses PNG. This compares shipped paths, not encoders in isolation.",
    "Shared-budget CPU is unassignable if foreign budget processes are present; sampled process PSS is null if any process denies access. RSS sums double-count shared pages.",
    "User-manager CPU is separate shared-service activity, not exclusive attribution. GPU/kernel memory and whole-machine cost are not measured.",
    "Fresh sessions are not cold file-cache starts. No viewer is attached, and there is no owner-session acceptance."] };
const errorText = (error: unknown): string => error instanceof AggregateError ?
  String(error) + ": " + error.errors.map(errorText).join("; ") : String(error);

const python = async (code: string, args: string[] = []) => {
  const child = Bun.spawn(["/usr/bin/python3", "-c", code, root, ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const boundedText = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        assert(bytes < 65536, "Python sample exceeds its bound");
        chunks.push(next.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  };
  let result: unknown, primary: unknown;
  const failures: unknown[] = [];
  try {
    const [stdout, stderr, exit] = await Promise.all([boundedText(child.stdout), boundedText(child.stderr), child.exited]);
    assert.equal(exit, 0, stderr);
    result = JSON.parse(stdout);
  } catch (error) { primary = error; }
  finally {
    if (child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch (error) { failures.push(error); }
      if (!await Promise.race([child.exited.then(() => true), Bun.sleep(1000).then(() => false)])) {
        try { child.kill("SIGKILL"); } catch (error) { failures.push(error); }
        if (!await Promise.race([child.exited.then(() => true), Bun.sleep(1000).then(() => false)]))
          failures.push(new Error("Python sample did not reap within its cleanup bound"));
      }
    }
    clearTimeout(timeout);
  }
  if (primary !== undefined || failures.length)
    throw new AggregateError([...(primary === undefined ? [] : [primary]), ...failures], "Python sample or cleanup failed");
  return result;
};
const setup = `import sys,os,json,hashlib
from pathlib import Path
root=Path(sys.argv[1]);sys.path.insert(0,str(root));sys.path.insert(0,str(root/'experiments/ghost-cursor'))
from lab import guard
from src.native.host import inspect_host
from src.native.control import ActionControl
from cursor_cost_probe import loaded_plugin
guard(os.environ);plan=inspect_host(os.environ)
with ActionControl(Path(sys.argv[2])) as control:control.configure(mode='full')
Path(sys.argv[3]).write_text(json.dumps(plan));Path(sys.argv[3]).chmod(0o600)
print(json.dumps(loaded_plugin(plan['compositor'][0],hashlib.sha256((root/'experiments/ghost-cursor/plugin/ghostinput.cpp').read_bytes()).hexdigest())))`;
const bindingCode = `import sys,os,json,hashlib
from pathlib import Path
root=Path(sys.argv[1]);sys.path.insert(0,str(root));sys.path.insert(0,str(root/'experiments/ghost-cursor'))
from lab import guard
from src.native.host import inspect_host
from cursor_cost_probe import loaded_plugin
guard(os.environ);plan=inspect_host(os.environ)
print(json.dumps(loaded_plugin(plan['compositor'][0],hashlib.sha256((root/'experiments/ghost-cursor/plugin/ghostinput.cpp').read_bytes()).hexdigest())))`;
const decodeFrame = `import sys,json,hashlib
from PIL import Image
with Image.open(sys.argv[2]) as image:
 assert image.size==(1280,800),image.size
 rgba=image.convert('RGBA');assert rgba.getextrema()[3][0]==255
 background=rgba.getpixel((30,400))[:3];assert all(abs(a-b)<=10 for a,b in zip(background,(241,244,248))),background
 entry=rgba.crop((85,165,475,203));content=max(b-a for a,b in entry.getextrema()[:3])>30
 print(json.dumps({'format':image.format,'width':image.width,'height':image.height,'background':background,'entryHasContent':content,'entrySha256':hashlib.sha256(entry.tobytes()).hexdigest(),'decodedSha256':hashlib.sha256(rgba.tobytes()).hexdigest()}))`;

const sampleCode = `import sys,os,json
from pathlib import Path
root=Path(sys.argv[1]);sys.path.insert(0,str(root/'experiments/ghost-cursor'))
from lab import guard,members
guard(os.environ);expected=int(sys.argv[2]);assert os.getppid()==expected
def stat(pid):
 s=Path(f'/proc/{pid}/stat').read_text();f=s[s.rfind(')')+2:].split();return int(f[19]),int(f[11])+int(f[12]),int(f[1])
owned=set();pending=[expected]
while pending:
 pid=pending.pop()
 if pid in owned:continue
 owned.add(pid)
 for task in Path(f'/proc/{pid}/task').iterdir():
  pending.extend(map(int,(task/'children').read_text().split()))
owned|=members(Path(os.environ['XDG_RUNTIME_DIR']).parent);owned.discard(os.getpid())
rows=[]
for pid in sorted(owned):
 if not Path(f'/proc/{pid}').exists():continue
 first=stat(pid);assert Path(f'/proc/{pid}').stat().st_uid==os.getuid()
 memory={};unmeasured=[]
 try:memory_text=Path(f'/proc/{pid}/smaps_rollup').read_text()
 except PermissionError as error:
  memory_text='';unmeasured.append({'metric':'Pss','reason':str(error)})
  for line in Path(f'/proc/{pid}/status').read_text().splitlines():
   if line.startswith('VmRSS:'):memory['Rss']=int(line.split()[1])*1024
 for line in memory_text.splitlines():
  key,_,value=line.partition(':')
  if key in ('Rss','Pss'):memory[key]=int(value.split()[0])*1024
 assert stat(pid)[0]==first[0]
 assert 'Rss' in memory
 if 'Pss' not in memory and not unmeasured:unmeasured.append({'metric':'Pss','reason':'smaps_rollup lacks Pss'})
 rows.append({'pid':pid,'start':first[0],'ticks':first[1],'name':Path(f'/proc/{pid}/comm').read_text().strip(),'unmeasured':unmeasured,**memory})
manager=[]
for path in Path('/proc').iterdir():
 if not path.name.isdigit():continue
 try:
  if path.stat().st_uid==os.getuid() and (path/'comm').read_text().strip()=='systemd' and b'--user' in (path/'cmdline').read_bytes().split(b'\\0'):
   start,ticks,_=stat(int(path.name));manager.append({'pid':int(path.name),'start':start,'ticks':ticks})
 except FileNotFoundError:pass
assert len(manager)<=1
path=next(line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
parts=path.split('/');budget=Path('/sys/fs/cgroup').joinpath(*parts[1:parts.index('sbarorbit.slice')+1]);budget_pids=set()
for group in budget.rglob('cgroup.procs'):
 try:budget_pids.update(map(int,group.read_text().split()))
 except FileNotFoundError:pass
allowed=owned|{os.getpid()};parent=expected
while parent>1:
 allowed.add(parent);parent=stat(parent)[2]
print(json.dumps({'processes':rows,'pssBytes':sum(p['Pss'] for p in rows) if all('Pss' in p for p in rows) else None,'readablePssSubtotalBytes':sum(p.get('Pss',0) for p in rows),'rssBytes':sum(p['Rss'] for p in rows),'manager':manager[0] if manager else None,'clockTicksPerSecond':os.sysconf('SC_CLK_TCK'),'foreignBudgetPids':sorted(budget_pids-allowed)}))`;
const sample = async () => ({ at: performance.now(), budget: await readCpuSample(),
  processes: await python(sampleCode, [String(process.pid)]) });
const wait = async (probe: () => Promise<boolean>, label: string) => {
  const deadline = performance.now() + 12_000;
  while (!await probe()) {
    assert(performance.now() < deadline, label);
    await Bun.sleep(5);
  }
};
const fixture = join(root, "experiments/fedora-display/fixture.py");
const rows: unknown[] = [];
const errors = report.errors as string[], cleanupErrors = report.cleanupErrors as string[];
try {
  report.loadedPlugin = await python(setup, [control, planPath]);
  for (const [index, kind] of ["fedora", "native", "native", "fedora"].entries()) {
    const trial = join(work, `${index}-${kind}`);
    await mkdir(trial, { mode: 0o700 });
    const statePath = join(trial, "fixture.json");
    assert.deepEqual(await python(bindingCode), report.loadedPlugin);
    const before = await sample();
    const start = performance.now();
    let backend: FedoraBackend | NativeBackend | undefined;
    try {
      backend = kind === "fedora" ? await FedoraBackend.create({ width: 1280, height: 800 }) :
        await NativeBackend.create("private", { planPath, controlDirectory: control });
      const backendReadyMs = performance.now() - start;
      let target: { appId: string; windowId: string } | undefined;
      const launchStart = performance.now();
      if (backend instanceof FedoraBackend) {
        await backend.act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/python3", fixture, statePath] });
      } else {
        const native = backend;
        const app = await native.act({ type: "launch", argv: ["/usr/bin/python3", fixture, statePath] }) as { appId: string };
        let windows: { windowId: string }[] = [];
        await wait(async () => {
          windows = (await native.act({ type: "windows", appId: app.appId }) as { windows: { windowId: string }[] }).windows;
          return windows.length === 1;
        }, "Current GTK3 fixture did not map");
        const window = windows[0]; assert(window);
        target = { appId: app.appId, windowId: window.windowId };
        await wait(async () => Bun.file(statePath).exists(), "Current GTK3 state missing before layout");
        await python(`import sys,os,json
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'experiments/ghost-cursor'));from lab import guard;from ghost import hypr
guard(os.environ);pid=int(sys.argv[2]);clients=json.loads(hypr('j/clients'));owned=[w for w in clients if w['pid']==pid];assert len(owned)==1
address=owned[0]['address'];assert owned[0]['workspace']['name']=='special:ghost'
for command in ('dispatch setfloating address:'+address,'dispatch resizewindowpixel exact 1280 800,address:'+address):assert hypr(command).strip()=='ok'
print('{}')`, [String((JSON.parse(await readFile(statePath, "utf8")) as { pid: number }).pid)]);
      }
      await wait(async () => Bun.file(statePath).exists(), "GTK3 fixture state missing");
      const applicationReadyMs = performance.now() - launchStart;
      const act = (value: Record<string, unknown>) => backend instanceof FedoraBackend ? backend.act(value) :
        backend?.act({ ...target, ...value });
      const point = (x: number, y: number) => act(backend instanceof FedoraBackend ? { type: "pointer", x, y } :
        { type: "click", x, y, button: "left" });
      const state = async () => JSON.parse(await readFile(statePath, "utf8")) as { pid: number; text: string; saved: string | null };
      const observe = async () => {
        assert(backend);
        const frame = record(await backend.observe(target));
        assert.equal(frame.width, 1280); assert.equal(frame.height, 800);
        assert(typeof frame.image === "string" && frame.image.length < 32 * 1024 * 1024);
        assert(frame.mimeType === "image/png" || frame.mimeType === "image/jpeg");
        return { image: frame.image, mimeType: frame.mimeType, width: frame.width, height: frame.height };
      };
      const roundTrip = async (message: string) => {
        const began = performance.now();
        await point(90, 185);
        await act({ type: "key", key: backend instanceof FedoraBackend ? "Ctrl+A" : "ctrl+a" });
        await act({ type: "text", text: message });
        await point(590, 185);
        const dispatchedMs = performance.now() - began;
        await wait(async () => (await state()).saved === message && (await state()).text === message, "GTK3 input/save round trip mismatch");
        return { dispatchedMs, deliveredMs: performance.now() - began };
      };
      await roundTrip("Perf warm up");
      const repaintStart = performance.now();
      let warmPixels: Record<string, unknown> = {}, warmFrames = 0;
      await wait(async () => {
        const warm = await observe();
        const warmPath = join(trial, `warm-frame-${warmFrames++}.bin`);
        await writeFile(warmPath, Buffer.from(warm.image, "base64"), { mode: 0o600 });
        warmPixels = record(await python(decodeFrame, [warmPath]));
        return warmPixels.entryHasContent === true;
      }, "GTK3 warm capture never displayed delivered text");
      const frameReadyMs = performance.now() - repaintStart;
      const activeBaseline = await sample();
      await Bun.sleep(3000);
      const idleEnd = await sample();
      const input = [];
      for (let iteration = 0; iteration < 12; iteration++) input.push(await roundTrip(`Perf ${index} input ${iteration}`));
      const inputEnd = await sample();
      const captures = [];
      for (let iteration = 0; iteration < 12; iteration++) {
        const began = performance.now();
        const frame = await observe();
        const milliseconds = performance.now() - began;
        assert.equal(frame.width, 1280); assert.equal(frame.height, 800);
        captures.push({ milliseconds, bytes: Buffer.from(frame.image, "base64").length, mimeType: frame.mimeType });
        if (iteration === 11) await writeFile(join(trial, "frame.bin"), Buffer.from(frame.image, "base64"), { mode: 0o600 });
      }
      const captureEnd = await sample();
      const finalPixels = record(await python(decodeFrame, [join(trial, "frame.bin")]));
      assert.equal(finalPixels.entryHasContent, true, "Final GTK3 entry pixels are blank");
      assert.notEqual(finalPixels.entrySha256, warmPixels.entrySha256, "GTK3 captured entry did not change after different input");
      assert.deepEqual(await python(bindingCode), report.loadedPlugin);
      const row = { kind, index, backendReadyMs, applicationReadyMs, frameReadyMs, warmFrames, input, captures,
        renderer: backend instanceof FedoraBackend ? backend.renderer : "private nested Hyprland; recorded in lab logs",
        before, activeBaseline, idleEnd, inputEnd, captureEnd, fixture: await state(),
        loadedPlugin: report.loadedPlugin, warmPixels, finalPixels };
      rows.push(row); report.rows = rows;
      await writeFile(join(trial, "report.json"), JSON.stringify(row, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ kind, index, backendReadyMs, applicationReadyMs }));
    } finally {
      if (backend) {
        try { await backend.close(); } catch (error) { cleanupErrors.push(errorText(error)); }
      }
    }
    await Bun.sleep(500);
  }
  assert.deepEqual(await hashes(), report.sourceSha256);
  report.complete = !cleanupErrors.length;
} catch (error) { errors.push(errorText(error)); }
finally {
  if (errors.length || cleanupErrors.length) report.complete = false;
  try { await writeFile(join(work, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
  catch (error) { cleanupErrors.push(errorText(error)); report.complete = false; console.error(JSON.stringify(report)); }
  console.log(JSON.stringify({ complete: report.complete, report: join(work, "report.json") }));
}
if (!report.complete) process.exitCode = 1;
