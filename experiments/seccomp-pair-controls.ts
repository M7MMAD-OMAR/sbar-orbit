import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

if (process.env.ORBIT_PAIR_CONTROLS !== "1") throw new Error("Set ORBIT_PAIR_CONTROLS=1");
await requireResourceBudget();
const unfixed = process.env.ORBIT_PAIR_UNFIXED_CONTROL === "1";
const root = await mkdtemp("/var/tmp/orbit-pair-controls-");
const runtime = await mkdtemp("/tmp/orbit-native-pair-");
const endpoint = join(runtime, "wayland-0"), binary = join(root, "broker"), report = join(root, "report.json");
const server = createServer(socket => socket.destroy());
try {
  await new Promise<void>((ready, fail) => { server.once("error", fail); server.listen(endpoint, ready); });
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary,
    resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(errors);
  const script = join(root, "controls.py");
  await writeFile(script, `import socket,os,sys,json,array,fcntl,errno,ctypes
results={}
def denial(name,call):
    try: results[name]={"result":call(),"errno":None}
    except OSError as error: results[name]={"result":None,"errno":error.errno}
pair,other=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM|socket.SOCK_CLOEXEC|socket.SOCK_NONBLOCK)
results["flags"]={"nonblocking":bool(fcntl.fcntl(pair.fileno(),fcntl.F_GETFL)&os.O_NONBLOCK),"cloexec":bool(fcntl.fcntl(pair.fileno(),fcntl.F_GETFD)&fcntl.FD_CLOEXEC)}
try:
    pair.sendmsg([b"A",b"B"])
    results["streamBytes"]=other.recv(2).decode()
except OSError as error:
    results["initialSendErrno"]=error.errno
    with open(sys.argv[1],"w") as result: json.dump(results,result)
    sys.exit(0)
denial("oversized",lambda:pair.sendmsg([b"X"*4097]))
denial("unsupportedFlags",lambda:pair.sendmsg([b"X"],[],socket.MSG_OOB))
foreign=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
device=os.open("/dev/null",os.O_RDONLY)
denial("foreignSocketRights",lambda:pair.sendmsg([b"X"],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[foreign.fileno()]))]))
denial("deviceRights",lambda:pair.sendmsg([b"X"],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[device]))]))
denial("noRejectedPayload",lambda:other.recv(1))
os.close(device); foreign.close()
delegated,peer=socket.socketpair()
pair.sendmsg([b"F"],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[delegated.fileno()]))])
payload,ancillary,flags,address=other.recvmsg(1,socket.CMSG_SPACE(4))
received=array.array("i"); received.frombytes(ancillary[0][2][:4])
delivered=socket.socket(fileno=received[0]); delivered.sendmsg([b"Z"])
results["delegatedBytes"]=payload.decode()+peer.recv(1).decode()
delivered.close(); delegated.close(); peer.close()
seq,seq_peer=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
seq.sendmsg([b"CD"]); seq.sendmsg([b"EF"])
results["packetBytes"]=[seq_peer.recv(8).decode(),seq_peer.recv(8).decode()]
seq.close(); seq_peer.close()
pair.send(b"G"); results["plainBytes"]=other.recv(1).decode()
old=pair.fileno(); pair.close(); other.close()
replacement=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
results["numberReused"]=replacement.fileno()==old
denial("reusedNumber",lambda:replacement.sendmsg([b"X"]))
replacement.close()
denial("datagramPair",lambda:socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM))
libc=ctypes.CDLL(None,use_errno=True)
invalid=libc.syscall(53,socket.AF_UNIX,socket.SOCK_STREAM,0,ctypes.c_void_p(1))
results["invalidArray"]={"result":invalid,"errno":ctypes.get_errno()}
extra=0
for attempt in range(130):
    try:
        first,second=socket.socketpair(); first.close(); second.close(); extra+=1
    except OSError as error:
        results["capacity"]={"extraPairs":extra,"errno":error.errno}
        break
with open(sys.argv[1],"w") as result: json.dump(results,result)
`, { mode: 0o600 });
  const child = Bun.spawn([binary, endpoint, "/usr/bin/python3", "-I", script, report], {
    env: { ...process.env, ORBIT_PRIVATE_BROKER_PAIRS: unfixed ? "0" : "1" }, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  const exit = await child.exited, standard = await stdout, diagnostic = await stderr;
  if (exit !== 0) throw new Error(JSON.stringify({ exit, standard, diagnostic }));
  const broker: unknown = JSON.parse(standard.trim());
  const results = JSON.parse(await readFile(report, "utf8")) as Record<string, unknown>;
  console.log(JSON.stringify({ unfixed, broker, results }, null, 2));
  if (unfixed) {
    if (results.initialSendErrno !== 13) throw new Error("Unfixed pair admission control did not fail");
  } else {
    if (results.streamBytes !== "AB" || results.delegatedBytes !== "FZ" || results.plainBytes !== "G" ||
        JSON.stringify(results.packetBytes) !== '["CD","EF"]' || results.numberReused !== true ||
        JSON.stringify(results.flags) !== '{"nonblocking":true,"cloexec":true}') throw new Error("Pair transport control failed");
    for (const name of ["oversized", "unsupportedFlags", "foreignSocketRights", "deviceRights", "reusedNumber", "datagramPair"])
      if ((results[name] as { errno?: number }).errno !== 13) throw new Error(`${name} was not denied`);
    if ((results.noRejectedPayload as { errno?: number }).errno !== 11) throw new Error("Denied payload reached its receiver");
    if (JSON.stringify(results.invalidArray) !== '{"result":-1,"errno":14}' ||
        JSON.stringify(results.capacity) !== '{"extraPairs":125,"errno":13}') throw new Error("Pair creation bounds failed");
  }
} finally {
  await new Promise<void>(ready => server.close(() => ready()));
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
