import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runtime = process.env.XDG_RUNTIME_DIR;
const enabled = process.platform === "linux" && runtime === `/run/user/${process.getuid?.()}` && !!Bun.which("bwrap");

async function listen(path: string): Promise<Server> {
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

(enabled ? test : test.skip)("GTK3 mount policy hides host sockets, preserves selected files and permits nested bubblewrap", async () => {
  const session = await mkdtemp(join(tmpdir(), "orbit-native-"));
  const outside = await mkdtemp(join(tmpdir(), "orbit-gtk3-host-"));
  const privateSocket = join(session, "private.sock");
  const hostSocket = join(outside, "host.sock");
  const hostRuntimeSocket = join(runtime!, `orbit-mount-test-${crypto.randomUUID()}.sock`);
  const document = join(outside, "document.txt");
  const output = join(session, "output.json");
  const report = join(session, "report.json");
  const servers: Server[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const renderNodes = existsSync("/dev/dri")
      ? (await Promise.all((await readdir("/dev/dri")).filter(name => /^renderD[0-9]+$/.test(name))
        .map(async name => ({ name, entry: await lstat(join("/dev/dri", name)) }))))
        .filter(({ entry }) => entry.isCharacterDevice()).map(({ name }) => name).sort()
      : [];
    servers.push(await listen(privateSocket), await listen(hostSocket), await listen(hostRuntimeSocket));
    await writeFile(document, "before");
    const info = await lstat(privateSocket, { bigint: true });
    const policy = { runtime, sockets: [{ path: privateSocket, device: String(info.dev), inode: String(info.ino) }] };
    const code = `import errno,json,os,pathlib,socket,subprocess
def connect(path):
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 try:
  s.connect(path);return "connected"
 except OSError as error:return errno.errorcode.get(error.errno,str(error.errno))
 finally:s.close()
document=pathlib.Path(${JSON.stringify(document)})
text=document.read_text();document.write_text("after")
nested=subprocess.run(["/usr/bin/bwrap","--bind","/","/","/usr/bin/true"],capture_output=True,text=True,timeout=8)
random=os.read(os.open("/dev/urandom",os.O_RDONLY),8)
render=sorted(path.name for path in pathlib.Path("/dev/dri").glob("renderD*") if path.is_char_device())
pathlib.Path(${JSON.stringify(output)}).write_text(json.dumps({"private":connect(${JSON.stringify(privateSocket)}),"host":connect(${JSON.stringify(hostSocket)}),"hostRuntime":connect(${JSON.stringify(hostRuntimeSocket)}),"text":text,"nested":nested.returncode,"nestedError":nested.stderr[-300:],"randomBytes":len(random),"renderNodes":render,"cardVisible":pathlib.Path("/dev/dri/card0").exists(),"uinputVisible":pathlib.Path("/dev/uinput").exists(),"hostProcVisible":pathlib.Path("/proc/${process.pid}/root").exists()}))`;
    child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), report,
      "--selected-files", JSON.stringify([document]), "--desktop-mount-policy", JSON.stringify(policy),
      "/usr/bin/python3", "-c", code], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    for (let attempt = 0; attempt < 200 && !await Bun.file(output).exists(); attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    const reportData = JSON.parse(await readFile(report, "utf8"));
    expect(reportData.error).toBeUndefined();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      private: "connected", host: "ENOENT", hostRuntime: "ENOENT", text: "before", nested: 0,
      nestedError: "", randomBytes: 8, renderNodes, cardVisible: false,
      uinputVisible: false, hostProcVisible: false,
    });
    expect(await readFile(document, "utf8")).toBe("after");
  } finally {
    if (child?.stdin && typeof child.stdin !== "number") child.stdin.end();
    if (child) await child.exited;
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(session, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}, 15000);

(enabled && existsSync("/tmp/.X11-unix") ? test : test.skip)("only the selected private X11 socket is rebound", async () => {
  const session = await mkdtemp(join(tmpdir(), "orbit-native-"));
  const number = Math.floor(100000 + Math.random() * 900000);
  const privateSocket = `/tmp/.X11-unix/X${number}`;
  const hostSocket = `/tmp/.X11-unix/X${number + 1}`;
  const output = join(session, "output.json");
  const report = join(session, "report.json");
  const servers: Server[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    servers.push(await listen(privateSocket), await listen(hostSocket));
    const info = await lstat(privateSocket, { bigint: true });
    const policy = { runtime, sockets: [{ path: privateSocket, device: String(info.dev), inode: String(info.ino) }] };
    const code = `import errno,json,pathlib,socket
def connect(path):
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 try:
  s.connect(path);return "connected"
 except OSError as error:return errno.errorcode.get(error.errno,str(error.errno))
 finally:s.close()
pathlib.Path(${JSON.stringify(output)}).write_text(json.dumps({"private":connect(${JSON.stringify(privateSocket)}),"host":connect(${JSON.stringify(hostSocket)})}))`;
    child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), report,
      "--desktop-mount-policy", JSON.stringify(policy), "/usr/bin/python3", "-c", code],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    for (let attempt = 0; attempt < 200 && !await Bun.file(output).exists(); attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    expect(JSON.parse(await readFile(report, "utf8")).error).toBeUndefined();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ private: "connected", host: "ENOENT" });
  } finally {
    if (child?.stdin && typeof child.stdin !== "number") child.stdin.end();
    if (child) await child.exited;
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(session, { recursive: true, force: true });
  }
}, 15000);

(enabled ? test : test.skip)("abstract host socket is denied while nested mounts remain available", async () => {
  const code = `import json,os,socket,subprocess,sys
sys.path.insert(0,${JSON.stringify(resolve("src/native"))})
from landlock_unix import make_abstract_ruleset,restrict_child
name=chr(0)+"orbit-abstract-test-"+str(os.getpid())
server=socket.socket(socket.AF_UNIX);server.bind(name);server.listen(2)
fd=make_abstract_ruleset()
client="import socket; s=socket.socket(socket.AF_UNIX);\\ntry: s.connect("+repr(name)+"); print('connected')\\nexcept OSError as error: print(error.errno)"
try:
 baseline=subprocess.run(["/usr/bin/python3","-c",client],capture_output=True,text=True,timeout=5)
 scoped=subprocess.run(["/usr/bin/python3","-c",client],capture_output=True,text=True,timeout=5,pass_fds=(fd,),preexec_fn=lambda:restrict_child(fd))
 print(json.dumps({"baseline":baseline.stdout.strip(),"scoped":scoped.stdout.strip(),"baselineExit":baseline.returncode,"scopedExit":scoped.returncode}))
finally:
 os.close(fd);server.close()`;
  const child = Bun.spawn(["/usr/bin/python3", "-c", code], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ baseline: "connected", scoped: "1", baselineExit: 0, scopedExit: 0 });
}, 10000);
