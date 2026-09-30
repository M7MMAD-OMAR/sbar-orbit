import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

if (process.env.ORBIT_SEND_PRESSURE_CONTROLS !== "1") throw new Error("Set ORBIT_SEND_PRESSURE_CONTROLS=1");
await requireResourceBudget();
const expectStall = process.env.ORBIT_SEND_PRESSURE_EXPECT_STALL === "1";
const root = await mkdtemp("/var/tmp/orbit-send-pressure-");
const runtime = await mkdtemp("/tmp/orbit-native-pressure-");
const endpoint = join(runtime, "wayland-0"), binary = join(root, "broker");
const server = createServer(socket => socket.destroy());
try {
  await new Promise<void>((ready, fail) => { server.once("error", fail); server.listen(endpoint, ready); });
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(errors);
  const script = join(root, "pressure.py");
  await writeFile(script, `import socket,os,sys,json,fcntl,time
report,operation=sys.argv[1:]
first,second=socket.socketpair()
first.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,4096)
second.setblocking(False)
def save(data):
    with open(report,"w") as result: json.dump(dict(pid=os.getpid(),operation=operation,**data),result)
filled=0
while True:
    try: filled+=first.sendmsg([b"X"*4096],[],socket.MSG_DONTWAIT)
    except BlockingIOError: break
save(dict(stage="saturated",filledBytes=filled))
started=time.monotonic()
try:
    sent=first.sendmsg([b"Y"]) if operation=="sendmsg" else first.send(b"Y")
    result=dict(sent=sent,errno=None)
except OSError as error: result=dict(sent=None,errno=error.errno)
elapsed=time.monotonic()-started
blockingFlag=not bool(fcntl.fcntl(first.fileno(),fcntl.F_GETFL)&os.O_NONBLOCK)
drained=0
while True:
    try: drained+=len(second.recv(8192))
    except BlockingIOError: break
first.sendmsg([b"Z"])
later=second.recv(1).decode()
save(dict(stage="finished",filledBytes=filled,drainedBytes=drained,elapsedSeconds=elapsed,blockingFlag=blockingFlag,laterBytes=later,**result))
first.close(); second.close()
`, { mode: 0o600 });
  for (const operation of ["sendmsg", "send"]) {
    const report = join(root, `${operation}.json`);
    const child = Bun.spawn([binary, endpoint, "/usr/bin/python3", "-I", script, report, operation], {
      env: { ...process.env, ORBIT_PRIVATE_BROKER_PAIRS: "1" }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    let terminal = false;
    void child.exited.then(() => { terminal = true; });
    let state: { pid?: number; stage?: string; filledBytes?: number; drainedBytes?: number;
      errno?: number; elapsedSeconds?: number; blockingFlag?: boolean; laterBytes?: string } = {};
    const deadline = Date.now() + 2500;
    try {
      while (!terminal && Date.now() < deadline) {
        try { state = JSON.parse(await readFile(report, "utf8")); } catch { /* Report write may be in progress. */ }
        await Bun.sleep(20);
      }
      if (!terminal) {
        // Only this wrapper's child group is eligible for cleanup.
        if (state.pid) process.kill(-state.pid, "SIGKILL");
        child.kill("SIGKILL");
      }
      const exit = await child.exited, standard = await stdout, diagnostic = await stderr;
      try { state = JSON.parse(await readFile(report, "utf8")); }
      catch { throw new Error(JSON.stringify({ exit, standard, diagnostic, state })); }
      console.log(JSON.stringify({ operation, expectStall, watchdogExpired: !terminal || state.stage === "saturated", exit, state,
        broker: standard.trim() ? JSON.parse(standard.trim()) : null, diagnostic }, null, 2));
      if (expectStall) {
        if (state.stage !== "saturated" || !state.filledBytes || exit === 0) throw new Error("Unfixed send did not stall after saturation");
      } else if (exit !== 0 || state.stage !== "finished" || state.errno !== 11 ||
        state.drainedBytes !== state.filledBytes || state.laterBytes !== "Z" || state.blockingFlag !== true ||
        state.elapsedSeconds === undefined || state.elapsedSeconds > 1) throw new Error("Broker send pressure control failed");
    } finally {
      if (!terminal) {
        if (state.pid) { try { process.kill(-state.pid, "SIGKILL"); } catch { /* Own group has already exited. */ } }
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }
} finally {
  await new Promise<void>(ready => server.close(() => ready()));
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
