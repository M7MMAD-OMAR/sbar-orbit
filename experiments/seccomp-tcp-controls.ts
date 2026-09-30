import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

if (process.env.ORBIT_TCP_CONTROLS !== "1") throw new Error("Set ORBIT_TCP_CONTROLS=1");
await requireResourceBudget();
const unfixed = process.env.ORBIT_TCP_UNFIXED_CONTROL === "1";
const root = await mkdtemp("/var/tmp/orbit-tcp-controls-");
const runtime = await mkdtemp("/tmp/orbit-native-tcp-");
const endpoint = join(runtime, "wayland-0"), binary = join(root, "broker"), report = join(root, "report.json");
const unix = createServer(socket => socket.destroy());
let selectedAccepts = 0, blockedAccepts = 0;
const selected = createServer(socket => { selectedAccepts++; socket.on("data", bytes => socket.write(bytes)); });
const blocked = createServer(socket => { blockedAccepts++; socket.destroy(); });
async function tcpPort(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((ready, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ready); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned TCP port");
  return address.port;
}
try {
  await new Promise<void>((ready, fail) => { unix.once("error", fail); unix.listen(endpoint, ready); });
  const selectedPort = await tcpPort(selected), blockedPort = await tcpPort(blocked);
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(errors);
  const script = join(root, "controls.py");
  await writeFile(script, `import socket,sys,json,array,os,select,fcntl
report,selected,blocked=sys.argv[1:]; selected=int(selected); blocked=int(blocked)
results={}
def denial(name,call):
    try: results[name]={"result":call(),"errno":None}
    except OSError as error: results[name]={"result":None,"errno":error.errno}
def receive(peer,size):
    readable,_,_=select.select([peer],[],[],1)
    if not readable: raise RuntimeError("no fixture echo")
    return peer.recv(size).decode()
first=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
try: first.connect(("127.0.0.1",selected))
except OSError as error:
    results["initialConnectErrno"]=error.errno
    with open(report,"w") as output: json.dump(results,output)
    sys.exit(0)
first.sendmsg([b"A",b"B"]); results["streamBytes"]=receive(first,2)
first.send(b"C"); results["plainBytes"]=receive(first,1)
file=os.open(report,os.O_WRONLY|os.O_CREAT,0o600)
denial("tcpRights",lambda:first.sendmsg([b"X"],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[file]))]))
os.close(file)
denial("oversized",lambda:first.sendmsg([b"X"*4097]))
denial("unsupportedFlags",lambda:first.sendmsg([b"X"],[],socket.MSG_OOB))
results["noRejectedPayload"]=not bool(select.select([first],[],[],0.05)[0])
old=first.fileno(); first.close()
other=socket.socket(socket.AF_INET,socket.SOCK_STREAM); results["numberReused"]=other.fileno()==old
denial("reusedNumber",lambda:other.sendmsg([b"X"]))
denial("otherPort",lambda:other.connect(("127.0.0.1",blocked)))
denial("otherAddress",lambda:other.connect(("127.0.0.2",selected)))
other.close()
udp=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
denial("udpConnect",lambda:udp.connect(("127.0.0.1",selected)))
denial("udpSendto",lambda:udp.sendto(b"X",("127.0.0.1",selected)))
udp.close()
last=socket.socket(socket.AF_INET,socket.SOCK_STREAM); last.setblocking(False)
results["nonblockingConnect"]=last.connect_ex(("127.0.0.1",selected))
_,writable,_=select.select([],[last],[],1)
if not writable: raise RuntimeError("nonblocking connect did not finish")
results["socketError"]=last.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR)
results["nonblockingFlag"]=bool(fcntl.fcntl(last.fileno(),fcntl.F_GETFL)&os.O_NONBLOCK)
last.sendmsg([b"EF"]); results["nonblockingBytes"]=receive(last,2); last.close()
with open(report,"w") as output: json.dump(results,output)
`, { mode: 0o600 });
  const child = Bun.spawn([binary, endpoint, "/usr/bin/python3", "-I", script, report, String(selectedPort), String(blockedPort)], {
    env: { ...process.env, ORBIT_PRIVATE_BROKER_PAIRS: "1", ORBIT_PRIVATE_BROKER_TCP_PORT: unfixed ? undefined : String(selectedPort) }, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  const exit = await child.exited, standard = await stdout, diagnostic = await stderr;
  if (exit !== 0) throw new Error(JSON.stringify({ exit, standard, diagnostic }));
  const results = JSON.parse(await readFile(report, "utf8")) as Record<string, unknown>;
  console.log(JSON.stringify({ unfixed, broker: JSON.parse(standard.trim()), results, selectedAccepts, blockedAccepts }, null, 2));
  if (unfixed) {
    if (results.initialConnectErrno !== 13 || selectedAccepts !== 0 || blockedAccepts !== 0) throw new Error("Inactive TCP route was not denied");
  } else {
    if (results.streamBytes !== "AB" || results.plainBytes !== "C" || results.nonblockingBytes !== "EF" ||
        results.socketError !== 0 || results.nonblockingFlag !== true || results.numberReused !== true ||
        results.noRejectedPayload !== true || ![0, 115].includes(Number(results.nonblockingConnect)) ||
        selectedAccepts !== 2 || blockedAccepts !== 0) throw new Error("Selected TCP transport control failed");
    for (const name of ["tcpRights", "oversized", "unsupportedFlags", "reusedNumber", "otherPort", "otherAddress", "udpConnect", "udpSendto"])
      if ((results[name] as { errno?: number }).errno !== 13) throw new Error(`${name} was not denied`);
  }
} finally {
  for (const server of [unix, selected, blocked]) await new Promise<void>(ready => server.close(() => ready()));
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
