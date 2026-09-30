/** Own launcher visibility, private process signaling and file access through the experimental broker. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const control = process.env.ORBIT_PID_NAMESPACE_CONTROL === "1";
const root = await mkdtemp("/var/tmp/orbit-pid-controls-"), runtime = await mkdtemp("/tmp/orbit-native-pid-");
const endpoint = join(runtime, "wayland-0"), binary = join(root, "broker"), report = join(root, "result.json");
const fixture = join(root, "generated.txt");
const server = createServer(socket => socket.destroy());
try {
  await new Promise<void>((ready, fail) => { server.once("error", fail); server.listen(endpoint, ready); });
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary, resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(errors);
  await writeFile(fixture, "generated-before\n", { mode: 0o600 });
  const script = join(root, "application.py");
  await writeFile(script, `import os,sys,json,signal,subprocess,errno,socket,struct
host=int(sys.argv[2]); results={'pid':os.getpid(),'hostProcVisible':os.path.exists('/proc/'+str(host)+'/stat')}
for name,call in [('hostSignal',lambda:os.kill(host,0)),('hostPidfd',lambda:os.pidfd_open(host))]:
    try:
        value=call(); results[name]={'errno':None}
        if name=='hostPidfd': os.close(value)
    except OSError as error: results[name]={'errno':error.errno}
child=subprocess.Popen(['/usr/bin/sleep','20']); os.kill(child.pid,signal.SIGTERM); child.wait(timeout=3)
results['privateChildSignal']=child.returncode==-signal.SIGTERM
first,second=socket.socketpair(); first.sendmsg([b'A']); results['pairBytes']=second.recv(1).decode()
results['pairPeerPid']=struct.unpack('3i',first.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0]
first.close(); second.close()
with open(sys.argv[3]) as f: results['fileRead']=f.read()=='generated-before\\n'
with open(sys.argv[3],'w') as f: f.write('generated-after\\n')
results['visibleProcessCount']=len([p for p in os.listdir('/proc') if p.isdigit()])
with open(sys.argv[1],'w') as f: json.dump(results,f)
`, { mode: 0o600 });
  const child = Bun.spawn([binary, endpoint, "/usr/bin/python3", "-I", script, report, String(process.pid), fixture], {
    env: { ...process.env, ORBIT_PRIVATE_BROKER_PAIRS: "1", ORBIT_PRIVATE_BROKER_PID_NAMESPACE: control ? "0" : "1" }, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  const exit = await child.exited, standard = await stdout, diagnostic = await stderr;
  if (exit !== 0) throw new Error(JSON.stringify({ exit, standard, diagnostic }));
  const result = JSON.parse(await readFile(report, "utf8")) as { pid: number; hostProcVisible: boolean; hostSignal: { errno: number | null }; hostPidfd: { errno: number | null }; privateChildSignal: boolean; pairBytes: string; pairPeerPid: number; fileRead: boolean; visibleProcessCount: number };
  const fileWrite = await readFile(fixture, "utf8") === "generated-after\n";
  if (!result.privateChildSignal || result.pairBytes !== "A" || !result.fileRead || !fileWrite) throw new Error("Private process or file capability failed");
  if (control) {
    if (!result.hostProcVisible || result.hostSignal.errno !== null || result.hostPidfd.errno !== null || result.pairPeerPid <= 0) throw new Error("Host visibility baseline not reproduced");
  } else if (result.hostProcVisible || result.hostSignal.errno !== 3 || result.hostPidfd.errno !== 3 || result.visibleProcessCount > 4 || result.pairPeerPid !== 0)
    throw new Error("Host processes remain reachable");
  const output = join(process.cwd(), "output", `seccomp-pid-controls${control ? "-control" : ""}-${new Date().toISOString().slice(0, 10)}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const evidence = { control, broker: JSON.parse(standard.trim()), result, fileWrite };
  await writeFile(join(output, "report.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally {
  await new Promise<void>(ready => server.close(() => ready()));
  await rm(root, { recursive: true, force: true }); await rm(runtime, { recursive: true, force: true });
}
