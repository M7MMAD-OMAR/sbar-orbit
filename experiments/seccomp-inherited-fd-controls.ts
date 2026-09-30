/** Demonstrate and reject inherited socket and terminal authority before experimental exec. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const unfixed = process.env.ORBIT_INHERITED_EXPECT_UNFIXED === "1";
const root = await mkdtemp("/var/tmp/orbit-inherited-controls-");
const runtime = await mkdtemp("/tmp/orbit-native-inherited-");
const endpoint = join(runtime, "wayland-0"), foreign = join(root, "foreign.sock"), binary = join(root, "broker");
let received = "";
const sockets = new Set<Socket>();
const track = (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); };
const selected = createServer(socket => { track(socket); socket.destroy(); });
const host = createServer(socket => { track(socket); socket.write("fixture-input"); socket.on("data", bytes => { received += bytes.toString(); }); });
const results: Record<string, unknown>[] = [];
try {
  for (const [server, path] of [[selected, endpoint], [host, foreign]] as const)
    await new Promise<void>((ready, fail) => { server.once("error", fail); server.listen(path, ready); });
  const compile = Bun.spawn(["cc", "-Wall", "-Wextra", "-Werror", "-O2", "-pthread", "-o", binary, resolve("experiments/seccomp-wayland-app-probe.c")], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(errors);
  const launch = join(root, "launch.py"), application = join(root, "application.py");
  await writeFile(launch, `import os,socket,sys,pty
binary,endpoint,application,report,foreign,mode,pairs=sys.argv[1:]
if mode=='terminal':
    master,slave=pty.openpty(); os.dup2(master,20); os.set_inheritable(20,True); os.dup2(slave,0); os.set_inheritable(0,True)
else:
    connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); connection.connect(foreign)
    os.dup2(connection.fileno(),19 if mode=='higher' else 0)
    os.set_inheritable(19 if mode=='higher' else 0,True)
env=dict(os.environ,ORBIT_PRIVATE_BROKER_PAIRS=pairs)
os.execve(binary,[binary,endpoint,'/usr/bin/python3','-I',application,report,mode],env)
`, { mode: 0o600 });
  await writeFile(application, `import os,sys,json
result={'executed':True}
try:
    if sys.argv[2]=='higher': result['written']=os.write(19,b'fixture-output')
    elif sys.argv[2]=='socket-input': result['input']=os.read(0,13).decode()
    else: result['terminal']=os.isatty(0)
except OSError as error: result['errno']=error.errno
with open(sys.argv[1],'w') as output: json.dump(result,output)
`, { mode: 0o600 });
  for (const test of [{ mode: "higher", pairs: "0" }, { mode: "higher", pairs: "1" }, { mode: "socket-input", pairs: "1" }, { mode: "terminal", pairs: "1" }]) {
    const report = join(root, `${test.mode}-${test.pairs}.json`);
    received = "";
    const child = Bun.spawn(["/usr/bin/python3", "-I", launch, binary, endpoint, application, report, foreign, test.mode, test.pairs], { stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    const exit = await child.exited, standard = await stdout, diagnostic = await stderr;
    let result: Record<string, unknown> | undefined;
    try { result = JSON.parse(await readFile(report, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const entry = { ...test, exit, result: result ?? null, foreignBytes: received.length, broker: standard.trim() ? JSON.parse(standard.trim()) : null, diagnostic };
    results.push(entry);
    console.error(JSON.stringify(entry));
    if (unfixed) {
      if (test.mode === "higher" && test.pairs === "0") {
        if (result?.written !== 14 || received !== "fixture-output") throw new Error("Unfixed inherited socket leak not reproduced");
      } else if (test.mode === "higher") {
        if (result?.errno !== 9 || received) throw new Error("Existing pair-mode cleanup changed");
      } else if (test.mode === "socket-input") {
        if (result?.input !== "fixture-input") throw new Error("Unfixed standard socket inheritance not reproduced");
      } else if (result?.terminal !== true) throw new Error("Unfixed terminal inheritance not reproduced");
    } else if (test.mode === "higher") {
      if (exit !== 0 || result?.errno !== 9 || received) throw new Error("Inherited high socket FD survived cleanup: " + JSON.stringify(entry));
    } else if (exit !== 2 || result) throw new Error("Unsafe standard descriptor reached application exec");
  }
} finally {
  for (const socket of sockets) socket.destroy();
  for (const server of [selected, host]) {
    await Promise.race([new Promise<void>(ready => server.close(() => ready())), Bun.sleep(500)]);
    if (server.listening) throw new Error("Fixture server did not close");
  }
  await rm(root, { recursive: true, force: true }); await rm(runtime, { recursive: true, force: true });
}
const directory = join(process.cwd(), "output", `seccomp-inherited-controls${unfixed ? "-before" : ""}-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, "report.json"), JSON.stringify({ unfixed, results }, null, 2) + "\n");
console.log(JSON.stringify({ unfixed, results }));
