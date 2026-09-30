import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

if (process.env.ORBIT_LOOPBACK_CONTROLS !== "1") throw new Error("Set ORBIT_LOOPBACK_CONTROLS=1");
await requireResourceBudget();
const unfixed = process.env.ORBIT_LOOPBACK_UNFIXED_CONTROL === "1";
const root = await mkdtemp("/var/tmp/orbit-loopback-controls-");
const runtime = await mkdtemp("/tmp/orbit-native-loopback-");
const endpoint = join(runtime, "wayland-0"), binary = join(root, "broker");
const server = createServer(socket => socket.destroy());
try {
  await new Promise<void>((ready, fail) => { server.once("error", fail); server.listen(endpoint, ready); });
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(errors);
  const script = join(root, "controls.py");
  await writeFile(script, `import socket,struct,os,sys,json
route=socket.socket(socket.AF_NETLINK,socket.SOCK_RAW,socket.NETLINK_ROUTE)
route.bind((os.getpid(),0))
def packet(kind=20,address="127.0.0.1",index=1,flags=1541,extra=b""):
    body=struct.pack("BBBBI",socket.AF_INET,8,128,254,index)
    for attr in [2,1]: body+=struct.pack("HH",8,attr)+socket.inet_aton(address)
    return struct.pack("IHHII",16+len(body)+len(extra),kind,flags,0,route.getsockname()[0])+body+extra
def link_packet(index=1,flags=1,change=1):
    body=struct.pack("BBHiII",0,0,0,index,flags,change)
    return struct.pack("IHHII",16+len(body),16,5,1,route.getsockname()[0])+body
cases={"hostValid":(packet(),0)} if sys.argv[2]=="host" else {
    "wrongAddress":(packet(address="127.0.0.2"),0),
    "wrongInterface":(packet(index=2),0),
    "wrongFlags":(packet(flags=5),0),
    "wrongType":(packet(kind=24),0),
    "extraData":(packet(extra=b"XXXX"),0),
    "userspaceDestination":(packet(),route.getsockname()[0]),
    "wrongLinkInterface":(link_packet(index=2),0),
    "wrongLinkFlags":(link_packet(flags=0),0),
    "wrongLinkChange":(link_packet(change=2),0)}
results={}
for name,(data,destination) in cases.items():
    try: results[name]={"sent":route.sendto(data,(destination,0)),"errno":None}
    except OSError as error: results[name]={"sent":None,"errno":error.errno}
route.close()
with open(sys.argv[1],"w") as result: json.dump(results,result)
`, { mode: 0o600 });
  const reports: Record<string, unknown> = {};
  for (const mode of ["host", "private"] as const) {
    const report = join(root, `${mode}.json`);
    const app = mode === "host" ? ["/usr/bin/python3", "-I", script, report, mode] :
      ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        "--proc", "/proc", "--dev", "/dev", "--bind", root, "/probe",
        "/usr/bin/python3", "-I", "/probe/controls.py", `/probe/${mode}.json`, mode];
    const child = Bun.spawn([binary, endpoint, ...app], {
      env: { ...process.env, ORBIT_PRIVATE_BROKER_LOOPBACK: unfixed ? "0" : "1" }, stdout: "pipe", stderr: "pipe" });
    const standard = new Response(child.stdout).text(), diagnostic = new Response(child.stderr).text();
    const exit = await child.exited;
    const stdout = await standard, stderr = await diagnostic;
    const broker = JSON.parse(stdout.trim()) as { forwardedLoopback: number };
    if (unfixed && mode === "private") {
      reports[mode] = { exit, broker, stderr, clientMeasured: false };
      if (exit !== 1 || broker.forwardedLoopback !== 0 || !stderr.includes("Failed RTM_NEWADDR"))
        throw new Error(JSON.stringify(reports));
      continue;
    }
    if (exit !== 0) throw new Error(JSON.stringify({ mode, exit, stdout, stderr }));
    const results = JSON.parse(await readFile(report, "utf8")) as Record<string, { sent: number | null; errno: number | null }>;
    reports[mode] = { broker, results };
    if (Object.values(results).some(result => result.sent !== null || result.errno !== 13) ||
        broker.forwardedLoopback !== (mode === "host" ? 0 : 2)) throw new Error(JSON.stringify(reports));
  }
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await new Promise<void>(ready => server.close(() => ready()));
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
