import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

if (process.env.ORBIT_CONNECT_PRESSURE_CONTROLS !== "1") throw new Error("Set ORBIT_CONNECT_PRESSURE_CONTROLS=1");
await requireResourceBudget();
const expectStall = process.env.ORBIT_CONNECT_PRESSURE_EXPECT_STALL === "1";
const root = await mkdtemp("/var/tmp/orbit-connect-pressure-");
const runtime = await mkdtemp("/tmp/orbit-native-connect-");
const endpoint = join(runtime, "wayland-0"), binary = join(root, "broker");
async function waitFile(path: string, timeout = 2000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch { await Bun.sleep(10); }
  }
  throw new Error(`Fixture did not produce ${path}`);
}
try {
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(errors);
  const serverScript = join(root, "server.py"), script = join(root, "connect.py");
  await writeFile(serverScript, `import socket,sys,time,json,os
endpoint,ready,drain,drained,received=sys.argv[1:]
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); server.bind(endpoint); server.listen(1)
fillers=[]
for attempt in range(2):
    filler=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); filler.connect(endpoint); fillers.append(filler)
check=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); check.setblocking(False)
try: check.connect(endpoint); raise RuntimeError("backlog not full")
except BlockingIOError as error:
    with open(ready,"w") as result: json.dump(dict(fullErrno=error.errno,fillers=len(fillers)),result)
check.close()
deadline=time.monotonic()+6
while not os.path.exists(drain):
    if time.monotonic()>deadline: raise RuntimeError("no drain request")
    time.sleep(0.005)
for filler in fillers:
    peer,_=server.accept(); peer.close(); filler.close()
with open(drained,"w") as result: result.write("ready")
server.settimeout(2)
peer,_=server.accept(); peer.settimeout(2)
data=peer.recv(2).decode()
with open(received,"w") as result: result.write(data)
peer.close(); server.close()
`, { mode: 0o600 });
  await writeFile(script, `import socket,sys,time,json,os,fcntl
endpoint,report,drain,drained,nonblocking=sys.argv[1:]
first=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
if nonblocking=="1": first.setblocking(False)
with open(report,"w") as result: json.dump(dict(pid=os.getpid(),stage="connecting"),result)
broker=os.getppid()
time.sleep(0.005)
fdsBefore=len(os.listdir(f"/proc/{broker}/fd"))
samples=[]
for attempt in range(1 if nonblocking=="1" else 8):
    if attempt: first=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    started=time.monotonic()
    try: first.connect(endpoint); error=None
    except OSError as failure: error=failure.errno
    elapsed=time.monotonic()-started
    flag=bool(fcntl.fcntl(first.fileno(),fcntl.F_GETFL)&os.O_NONBLOCK)
    first.close()
    time.sleep(0.005)
    samples.append(dict(errno=error,elapsedSeconds=elapsed,nonblocking=flag,brokerThreads=len(os.listdir(f"/proc/{broker}/task"))))
fdsAfter=len(os.listdir(f"/proc/{broker}/fd"))
with open(drain,"w") as result: result.write("drain")
deadline=time.monotonic()+2
while not os.path.exists(drained):
    if time.monotonic()>deadline: raise RuntimeError("server did not drain")
    time.sleep(0.005)
later=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); later.connect(endpoint); later.sendmsg([b"AB"]); later.close()
with open(report,"w") as result: json.dump(dict(pid=os.getpid(),stage="finished",samples=samples,fdsBefore=fdsBefore,fdsAfter=fdsAfter),result)
`, { mode: 0o600 });
  for (const nonblocking of expectStall ? [false] : [false, true]) {
    const prefix = join(root, nonblocking ? "nonblocking" : "blocking");
    const ready = `${prefix}.ready`, drain = `${prefix}.drain`, drained = `${prefix}.drained`, received = `${prefix}.received`, report = `${prefix}.json`;
    const server = Bun.spawn(["/usr/bin/python3", "-I", serverScript, endpoint, ready, drain, drained, received], { stdout: "pipe", stderr: "pipe" });
    const serverOutput = new Response(server.stdout).text(), serverErrors = new Response(server.stderr).text();
    let clientPid: number | undefined;
    try {
      const readyState: unknown = JSON.parse(await waitFile(ready));
      const child = Bun.spawn([binary, endpoint, "/usr/bin/python3", "-I", script, endpoint, report, drain, drained, nonblocking ? "1" : "0"], { stdout: "pipe", stderr: "pipe" });
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
      let terminal = false;
      void child.exited.then(() => { terminal = true; });
      try {
        const starting = JSON.parse(await waitFile(report)) as { pid: number };
        clientPid = starting.pid;
        const deadline = Date.now() + 2500;
        while (!terminal && Date.now() < deadline) await Bun.sleep(10);
        const watchdogExpired = !terminal;
        if (watchdogExpired) { process.kill(-clientPid, "SIGKILL"); child.kill("SIGKILL"); }
        const exit = await child.exited, standard = await stdout, diagnostic = await stderr;
        const state = JSON.parse(await readFile(report, "utf8")) as { stage: string; fdsBefore?: number; fdsAfter?: number;
          samples?: { errno: number; elapsedSeconds: number; nonblocking: boolean; brokerThreads: number }[] };
        console.log(JSON.stringify({ expectStall, nonblocking, watchdogExpired, readyState, exit, state, broker: standard.trim() ? JSON.parse(standard.trim()) : null, diagnostic }, null, 2));
        if (expectStall) {
          if (!watchdogExpired || state.stage !== "connecting") throw new Error("Unfixed connect did not stall");
        } else {
          if (exit !== 0 || watchdogExpired || state.stage !== "finished" || state.samples?.length !== (nonblocking ? 1 : 8) ||
            state.samples.some(sample => sample.errno !== (nonblocking ? 11 : 110) || sample.nonblocking !== nonblocking ||
              sample.elapsedSeconds > 1 || sample.brokerThreads !== 1) || state.fdsBefore !== state.fdsAfter ||
            await waitFile(received) !== "AB") throw new Error("Bounded connect pressure control failed");
        }
      } finally {
        if (!terminal) {
          if (clientPid) { try { process.kill(-clientPid, "SIGKILL"); } catch { /* Own target already exited. */ } }
          child.kill("SIGKILL"); await child.exited;
        }
      }
    } finally {
      server.kill("SIGKILL");
      await server.exited; await serverOutput; await serverErrors;
      await rm(endpoint, { force: true });
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
