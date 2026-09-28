import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { linuxOnlySuite } from "./platform-support";

const linuxTest = linuxOnlySuite("pathname UNIX socket Landlock policy is a Linux supervisor feature");

async function listen(path: string): Promise<Server> {
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

async function identity(path: string) {
  const stat = await lstat(path, { bigint: true });
  return { path, device: String(stat.dev), inode: String(stat.ino) };
}

async function supervised(root: string, sockets: Awaited<ReturnType<typeof identity>>[], code: string, readyPath?: string) {
  const report = join(root, `${crypto.randomUUID()}.json`);
  const child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), report,
    "--socket-policy", JSON.stringify(sockets), "/usr/bin/python3", "-c", code],
  { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  let result: { pid?: number; error?: { code: string; message: string } } | undefined;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { result = JSON.parse(await readFile(report, "utf8")); break; } catch {}
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    if (!result) throw new Error("Supervisor exited without a report");
    if (result.pid && readyPath) {
      for (let attempt = 0; attempt < 100 && !await Bun.file(readyPath).exists(); attempt++) await Bun.sleep(20);
      if (!await Bun.file(readyPath).exists()) throw new Error("Application did not finish its fixture work");
    }
    return result;
  } finally {
    child.stdin?.end();
    await child.exited;
  }
}

linuxTest("supervised app permits one exact socket and ordinary file work", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-landlock-test-"));
  const allowed = join(root, "allowed.sock");
  const denied = join(root, "denied.sock");
  const output = join(root, "output.json");
  const servers: Server[] = [];
  try {
    servers.push(await listen(allowed), await listen(denied));
    const code = `import errno,json,os,pathlib,socket
root=pathlib.Path(${JSON.stringify(root)})
def connect(path):
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 try:
  s.connect(path); return "connected"
 except OSError as e: return errno.errorcode.get(e.errno,str(e.errno))
 finally: s.close()
(root/"a").mkdir(); (root/"b").mkdir()
source=root/"a"/"draft.txt"; source.write_text("kept")
content=source.read_text(); moved=root/"b"/"draft.txt"; os.replace(source,moved)
renamed=root/"b"/"done.txt"; os.replace(moved,renamed)
descriptors=[]
for name in os.listdir("/proc/self/fd"):
 try: descriptors.append(os.readlink("/proc/self/fd/"+name))
 except FileNotFoundError: pass
(root/"output.json").write_text(json.dumps({"allowed":connect(str(root/"allowed.sock")),"denied":connect(str(root/"denied.sock")),"read":content,"crossRename":not source.exists() and renamed.exists(),"sameRename":not moved.exists(),"rulesetFdLeaked":any("landlock-ruleset" in path for path in descriptors)}))`;
    const result = await supervised(root, [await identity(allowed)], code, output);
    expect(result.error).toBeUndefined();
    expect(result.pid).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      allowed: "connected", denied: "EACCES", read: "kept", crossRename: true, sameRename: true,
      rulesetFdLeaked: false,
    });
  } finally {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

linuxTest("changed or missing socket identity refuses to start", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-landlock-test-"));
  const path = join(root, "allowed.sock");
  const server = await listen(path);
  try {
    const socket = await identity(path);
    const code = `import pathlib;pathlib.Path(${JSON.stringify(join(root, "launched"))}).touch()`;
    const mismatch = await supervised(root, [{ ...socket, inode: String(BigInt(socket.inode) + 1n) }], code);
    expect(mismatch.error?.code).toBe("UNSUPPORTED");
    const absent = await supervised(root, [{ ...socket, path: join(root, "absent.sock") }], code);
    expect(absent.error?.code).toBe("UNSUPPORTED");
    expect(await Bun.file(join(root, "launched")).exists()).toBe(false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
