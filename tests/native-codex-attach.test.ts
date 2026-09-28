import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prepareCodexAttachedLaunch } from "../src/native-codex-attach";
import { FedoraBackend, parseNativeAction } from "../src/fedora";

const runtime = `/run/user/${process.getuid?.()}`;
const enabled = process.platform === "linux" && process.env.XDG_RUNTIME_DIR === runtime &&
  homedir().startsWith("/home/") && homedir().split("/").length === 3 && !!Bun.which("bwrap");

test("Codex active action refuses a missing owner before copying or launching", async () => {
  const session = await mkdtemp("/tmp/orbit-native-codex-attach-test-");
  const oldSocket = process.env.ORBIT_CODEX_AUTHORITY_SOCKET;
  process.env.ORBIT_CODEX_AUTHORITY_SOCKET = join(runtime, `orbit-codex-absent-${crypto.randomUUID()}`, "app-server.sock");
  try {
    const backend = Object.assign(Object.create(FedoraBackend.prototype), {
      parseAction: parseNativeAction, closed: false, children: [], directory: session,
      env: { XDG_RUNTIME_DIR: session, LD_LIBRARY_PATH: "/usr/lib" }, waylandDisplay: "wayland-0",
    }) as FedoraBackend;
    const before = await readdir(session);
    await expect(backend.act({ type: "launch-app", app: "codex", profile: "active" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("running Desktop authority") });
    expect(await readdir(session)).toEqual(before);
    expect((backend as unknown as { children: unknown[] }).children).toEqual([]);
  } finally {
    if (oldSocket === undefined) delete process.env.ORBIT_CODEX_AUTHORITY_SOCKET;
    else process.env.ORBIT_CODEX_AUTHORITY_SOCKET = oldSocket;
    await rm(session, { recursive: true, force: true });
  }
});

async function listen(path: string, value: string): Promise<Server> {
  const server = createServer(socket => socket.end(value));
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, resolveListen);
  });
  return server;
}

async function close(server?: Server) {
  if (server) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

(enabled ? test : test.skip)("Codex attach mounts verified authority sockets into a fresh private home", async () => {
  const session = await mkdtemp("/tmp/orbit-native-codex-attach-test-");
  const socketDirectory = await mkdtemp(join(runtime, "orbit-codex-attach-test-"));
  const authorityPath = join(socketDirectory, "authority.sock");
  const authorityStatePath = `${authorityPath}.state`;
  const displayPath = join(session, "display.sock");
  const executable = join(session, "fixture-client.py");
  const output = join(session, "result.json");
  const report = join(session, "report.json");
  let authority: Server | undefined;
  let authorityState: Server | undefined;
  let display: Server | undefined;
  let prepared: Awaited<ReturnType<typeof prepareCodexAttachedLaunch>> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    authority = await listen(authorityPath, "fixture-authority");
    authorityState = await listen(authorityStatePath, "fixture-state");
    display = await listen(displayPath, "fixture-display");
    await chmod(authorityPath, 0o600);
    await chmod(authorityStatePath, 0o600);
    const program = `#!/usr/bin/python3
import json, os, pathlib, socket
endpoint = os.environ["CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET"]
with socket.socket(socket.AF_UNIX) as client:
    client.connect(endpoint)
    answer = client.recv(100).decode()
with socket.socket(socket.AF_UNIX) as client:
    client.connect(endpoint + ".state")
    state_answer = client.recv(100).decode()
pathlib.Path(${JSON.stringify(output)}).write_text(json.dumps({
    "answer": answer,
    "stateAnswer": state_answer,
    "attachOnly": os.environ.get("CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY"),
    "privateCodexHome": os.environ.get("CODEX_LINUX_APP_SERVER_BRIDGE_PRIVATE_CODEX_HOME") == os.environ["CODEX_HOME"],
    "appDirectory": os.environ.get("CODEX_LINUX_APP_DIR") == os.path.dirname(${JSON.stringify(executable)}),
    "gsettingsBackend": os.environ.get("GSETTINGS_BACKEND"),
    "sourceVisible": pathlib.Path(${JSON.stringify(authorityPath)}).exists(),
    "stateSourceVisible": pathlib.Path(${JSON.stringify(authorityStatePath)}).exists(),
    "homeEntries": sorted(os.listdir(os.environ["HOME"])),
    "codexEntries": sorted(os.listdir(os.environ["CODEX_HOME"])),
    "privateSocket": endpoint == ${JSON.stringify(join(runtime, "orbit-codex-authority.sock"))}
}))
`;
    await writeFile(executable, program, { mode: 0o700 });
    prepared = await prepareCodexAttachedLaunch(session,
      { runtimeDirectory: session, waylandDisplay: "wayland-0", libraryPath: "/usr/lib" },
      authorityPath, executable);
    expect(await readdir(join(prepared.privateHome, ".codex"))).toEqual([]);
    expect(await readdir(join(prepared.privateHome, ".config", "Codex"))).toEqual([]);
    expect(prepared.argv.join(" ")).not.toContain(authorityPath);
    expect(prepared.argv).toContain("GSETTINGS_BACKEND=dconf");
    expect(prepared.argv).toContain(`CODEX_LINUX_APP_SERVER_BRIDGE_PRIVATE_CODEX_HOME=${join(homedir(), ".codex")}`);
    const displayInfo = await lstat(displayPath, { bigint: true });
    const policy = { runtime, sockets: [{ path: displayPath, device: String(displayInfo.dev), inode: String(displayInfo.ino) }],
      privateHome: prepared.privateHome, authoritySocket: prepared.authoritySocket,
      authorityStateSocket: prepared.authorityStateSocket };
    child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), report,
      "--desktop-mount-policy", JSON.stringify(policy), ...prepared.argv],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    for (let attempt = 0; attempt < 200 && !await Bun.file(output).exists(); attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    expect(JSON.parse(await readFile(report, "utf8")).error).toBeUndefined();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      answer: "fixture-authority", stateAnswer: "fixture-state", attachOnly: "1", privateCodexHome: true,
      appDirectory: true,
      gsettingsBackend: "dconf", sourceVisible: false, stateSourceVisible: false,
      homeEntries: [".cache", ".codex", ".config", ".local"], codexEntries: [], privateSocket: true,
    });
    const refused = join(session, "refused.json");
    const invalid = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), refused,
      "--desktop-mount-policy", JSON.stringify({ ...policy,
        authoritySocket: { ...prepared.authoritySocket, inode: String(BigInt(prepared.authoritySocket.inode) + 1n) } }),
      "/usr/bin/true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await invalid.exited;
    expect(JSON.parse(await readFile(refused, "utf8")).error.code).toBe("UNSUPPORTED");
    const stateRefused = join(session, "state-refused.json");
    const invalidState = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), stateRefused,
      "--desktop-mount-policy", JSON.stringify({ ...policy,
        authorityStateSocket: { ...prepared.authorityStateSocket,
          inode: String(BigInt(prepared.authorityStateSocket.inode) + 1n) } }),
      "/usr/bin/true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await invalidState.exited;
    expect(JSON.parse(await readFile(stateRefused, "utf8")).error.code).toBe("UNSUPPORTED");
  } finally {
    if (child?.stdin && typeof child.stdin !== "number") child.stdin.end();
    if (child) await child.exited;
    if (prepared) await prepared.release();
    await close(display);
    await close(authorityState);
    await close(authority);
    await rm(session, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  }
}, 15000);

(enabled ? test : test.skip)("Codex attach rejects permissive and linked authority sockets", async () => {
  const session = await mkdtemp("/tmp/orbit-native-codex-attach-test-");
  const socketDirectory = await mkdtemp(join(runtime, "orbit-codex-attach-test-"));
  const authorityPath = join(socketDirectory, "authority.sock");
  const linkedPath = join(socketDirectory, "linked.sock");
  const executable = join(session, "fixture-client");
  let authority: Server | undefined;
  try {
    authority = await listen(authorityPath, "fixture-authority");
    await writeFile(executable, "fixture", { mode: 0o700 });
    const display = { runtimeDirectory: session, waylandDisplay: "wayland-0", libraryPath: "/usr/lib" };
    await chmod(authorityPath, 0o666);
    await expect(prepareCodexAttachedLaunch(session, display, authorityPath, executable)).rejects.toThrow();
    await chmod(authorityPath, 0o600);
    await symlink(authorityPath, linkedPath);
    await expect(prepareCodexAttachedLaunch(session, display, linkedPath, executable)).rejects.toThrow();
    await expect(prepareCodexAttachedLaunch(session, display, join(session, "missing.sock"), executable))
      .rejects.toThrow();
    await expect(prepareCodexAttachedLaunch(session, display, authorityPath, "/usr/bin/true"))
      .rejects.toThrow();
  } finally {
    await close(authority);
    await rm(session, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  }
}, 15000);
