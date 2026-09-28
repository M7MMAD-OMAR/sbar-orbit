import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseNativeAction } from "../src/fedora";
import { cleanOrphanCodexSnapshots, prepareCodexLaunch } from "../src/native-codex";

const fixtureAccess = `header.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.signature`;
const fixtureAuth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { id_token: "fixture-id", access_token: fixtureAccess, refresh_token: "fixture-refresh", account_id: "fixture-account" },
  last_refresh: "2026-09-28T00:00:00Z",
});

async function fixtureState(root: string) {
  const stateHome = join(root, "state-source");
  await mkdir(stateHome);
  await writeFile(join(stateHome, ".codex-global-state.json"), "{}\n");
  await writeFile(join(stateHome, "config.toml"), 'model = "fixture"\n');
  const database = new Database(join(stateHome, "state_5.sqlite"), { create: true });
  database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);");
  database.close();
  return stateHome;
}

test("Codex orphan sweep removes only an expired private snapshot", async () => {
  const root = await mkdtemp("/tmp/orbit-codex-clean-test-");
  const stale = join(root, "codex-ABC123");
  const recent = join(root, "codex-DEF456");
  const active = join(root, "codex-GHI789");
  const unrelated = join(root, "other-data");
  try {
    for (const path of [stale, recent, active, unrelated]) await mkdir(path, { mode: 0o700 });
    await writeFile(join(stale, "owner.json"), JSON.stringify({ pid: 99999999, startTicks: "1" }), { mode: 0o600 });
    const selfStat = await readFile("/proc/self/stat", "utf8");
    const startTicks = selfStat.slice(selfStat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    await writeFile(join(active, "owner.json"), JSON.stringify({ pid: process.pid, startTicks }), { mode: 0o600 });
    await utimes(stale, new Date(0), new Date(0));
    await utimes(active, new Date(0), new Date(0));
    await utimes(unrelated, new Date(0), new Date(0));
    expect(await cleanOrphanCodexSnapshots(root, Date.now())).toEqual(["codex-ABC123"]);
    expect(await stat(recent).then(value => value.isDirectory())).toBe(true);
    expect(await stat(active).then(value => value.isDirectory())).toBe(true);
    expect(await stat(unrelated).then(value => value.isDirectory())).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex launch action accepts the installed active profile without caller arguments", () => {
  expect(parseNativeAction({ type: "launch-app", app: "codex", profile: "active" })).toEqual(
    { type: "launch-app", app: "codex", profile: "active" });
  expect(() => parseNativeAction({ type: "launch-app", app: "codex", profile: "active", argv: ["/bin/sh"] })).toThrow();
});

test("Codex account snapshot writes only to a private home and removes it", async () => {
  const root = await mkdtemp("/tmp/orbit-native-codex-test-");
  const source = join(root, "auth.json");
  const executable = join(root, "ChatGPT");
  await writeFile(source, fixtureAuth, { mode: 0o600 });
  await writeFile(executable, "fixture", { mode: 0o700 });
  try {
    const stateHome = await fixtureState(root);
    const prepared = await prepareCodexLaunch(root,
      { runtimeDirectory: root, waylandDisplay: "wayland-0", libraryPath: "/usr/lib" },
      { authPath: source, executable, stateHome });
    const copied = join(prepared.privateHome, ".codex", "auth.json");
    try {
      const copiedAccount = JSON.parse(await readFile(copied, "utf8"));
      expect(copiedAccount.tokens.access_token).toBe(fixtureAccess);
      expect(copiedAccount.tokens.refresh_token).toBe("");
      expect(prepared.argv.join(" ")).not.toContain(source);
      expect(prepared.argv[1]).toBe("-i");
      expect(prepared.argv.some(value => value.startsWith("CODEX_HOME=") && value.endsWith("/.codex"))).toBe(true);
      expect(prepared.accountSnapshot.projects).toBe(0);
      expect(prepared.accountSnapshot.threads).toBe(0);
      expect(await readFile(join(prepared.privateHome, ".codex", "config.toml"), "utf8"))
        .toBe('model = "fixture"\n');
      await writeFile(copied, "private change");
      expect(await readFile(source, "utf8")).toBe(fixtureAuth);
    } finally { await prepared.release(); }
    expect(await stat(prepared.privateHome).then(() => true, () => false)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex account snapshot rejects a linked credential file", async () => {
  const root = await mkdtemp("/tmp/orbit-native-codex-test-");
  const source = join(root, "auth.json");
  const linked = join(root, "linked-auth.json");
  const executable = join(root, "ChatGPT");
  await writeFile(source, fixtureAuth, { mode: 0o600 });
  await symlink(source, linked);
  await writeFile(executable, "fixture", { mode: 0o700 });
  try {
    const stateHome = await fixtureState(root);
    await expect(prepareCodexLaunch(root,
      { runtimeDirectory: root, waylandDisplay: "wayland-0", libraryPath: "/usr/lib" },
      { authPath: linked, executable, stateHome })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

const runtime = process.env.XDG_RUNTIME_DIR;
const mountEnabled = process.platform === "linux" && runtime === `/run/user/${process.getuid?.()}` &&
  homedir().startsWith("/home/") && homedir().split("/").length === 3 && !!Bun.which("bwrap");

(mountEnabled ? test : test.skip)("Codex private mount hides the original home and maps the snapshot", async () => {
  const session = await mkdtemp("/tmp/orbit-native-codex-test-");
  const privateHome = join(session, "snapshot", "home");
  const socketPath = join(session, "private.sock");
  const output = join(session, "output.json");
  const report = join(session, "report.json");
  await mkdir(privateHome, { recursive: true, mode: 0o700 });
  await writeFile(join(privateHome, "marker"), "private", { mode: 0o600 });
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const info = await lstat(socketPath, { bigint: true });
    const policy = { runtime, sockets: [{ path: socketPath, device: String(info.dev), inode: String(info.ino) }], privateHome };
    const code = `import json,os,pathlib
home=pathlib.Path(${JSON.stringify(homedir())})
pathlib.Path(${JSON.stringify(output)}).write_text(json.dumps({"marker":(home/"marker").read_text(),"homeEntries":sorted(os.listdir("/home"))}))`;
    child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), report,
      "--desktop-mount-policy", JSON.stringify(policy), "/usr/bin/python3", "-c", code],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    for (let attempt = 0; attempt < 200 && !await Bun.file(output).exists(); attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    expect(JSON.parse(await readFile(report, "utf8")).error).toBeUndefined();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ marker: "private", homeEntries: [basename(homedir())] });
    const refused = join(session, "refused.json");
    const invalid = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), refused,
      "--desktop-mount-policy", JSON.stringify({ ...policy, privateHome: "/tmp" }), "/usr/bin/true"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await invalid.exited;
    expect(JSON.parse(await readFile(refused, "utf8")).error.code).toBe("UNSUPPORTED");
  } finally {
    if (child?.stdin && typeof child.stdin !== "number") child.stdin.end();
    if (child) await child.exited;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(session, { recursive: true, force: true });
  }
}, 15000);

(mountEnabled ? test : test.skip)("Codex disk snapshot mounts at the user's home without exposing the original home", async () => {
  const session = await mkdtemp("/tmp/orbit-native-codex-test-");
  const storage = join(homedir(), ".cache", "sbar-orbit", "codex-private");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(storage, "codex-"));
  const privateHome = join(root, "home");
  const socketPath = join(session, "private.sock");
  const output = join(session, "output.json");
  const report = join(session, "report.json");
  await mkdir(privateHome, { mode: 0o700 });
  await writeFile(join(privateHome, "marker"), "disk snapshot", { mode: 0o600 });
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const info = await lstat(socketPath, { bigint: true });
    const policy = { runtime, sockets: [{ path: socketPath, device: String(info.dev), inode: String(info.ino) }], privateHome };
    const code = `import json,pathlib
home=pathlib.Path(${JSON.stringify(homedir())})
pathlib.Path(${JSON.stringify(output)}).write_text(json.dumps({"marker":(home/"marker").read_text(),"entries":len(list(pathlib.Path("/home").iterdir()))}))`;
    child = Bun.spawn(["/usr/bin/python3", resolve("src/native/supervise.py"), report,
      "--desktop-mount-policy", JSON.stringify(policy), "/usr/bin/python3", "-c", code],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    for (let attempt = 0; attempt < 200 && !await Bun.file(output).exists(); attempt++) {
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    expect(JSON.parse(await readFile(report, "utf8")).error).toBeUndefined();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ marker: "disk snapshot", entries: 1 });
  } finally {
    if (child?.stdin && typeof child.stdin !== "number") child.stdin.end();
    if (child) await child.exited;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(session, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
