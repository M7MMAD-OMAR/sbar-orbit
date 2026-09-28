import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseNativeAction } from "../src/fedora";
import { prepareCodexLaunch } from "../src/native-codex";

const fixtureAccess = `header.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.signature`;
const fixtureAuth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { id_token: "fixture-id", access_token: fixtureAccess, refresh_token: "fixture-refresh", account_id: "fixture-account" },
  last_refresh: "2026-09-28T00:00:00Z",
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
    const prepared = await prepareCodexLaunch(root,
      { runtimeDirectory: root, waylandDisplay: "wayland-0", libraryPath: "/usr/lib" },
      { authPath: source, executable });
    const copied = join(prepared.privateHome, ".codex", "auth.json");
    try {
      const copiedAccount = JSON.parse(await readFile(copied, "utf8"));
      expect(copiedAccount.tokens.access_token).toBe(fixtureAccess);
      expect(copiedAccount.tokens.refresh_token).toBe("");
      expect(prepared.argv.join(" ")).not.toContain(source);
      expect(prepared.argv[1]).toBe("-i");
      expect(prepared.argv.some(value => value.startsWith("CODEX_HOME=") && value.endsWith("/.codex"))).toBe(true);
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
    await expect(prepareCodexLaunch(root,
      { runtimeDirectory: root, waylandDisplay: "wayland-0", libraryPath: "/usr/lib" },
      { authPath: linked, executable })).rejects.toThrow();
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
