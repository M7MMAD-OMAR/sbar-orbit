import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { FedoraBackend } from "../src/fedora";

const claude = process.env.ORBIT_CLAUDE_ELF ??
  join(homedir(), "Applications", "claude-desktop", "usr", "lib", "claude-desktop", "claude-desktop");
const report: Record<string, unknown> = {};
const backend = await FedoraBackend.create();
const privateSession = backend as unknown as { directory: string; env: NodeJS.ProcessEnv };
const directory = privateSession.directory;
const environment = privateSession.env;
const home = join(directory, "claude-home");
const runtime = directory;
const keyringControl = join(runtime, "keyring");
let keyring: ChildProcessWithoutNullStreams | undefined;
try {
  for (const path of [home, runtime, keyringControl, join(home, ".config"), join(home, ".local", "share"),
    join(home, ".local", "state"), join(home, ".cache")])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const privateEnv = {
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS ?? "",
    WAYLAND_DISPLAY: environment.WAYLAND_DISPLAY ?? "",
    LD_LIBRARY_PATH: environment.LD_LIBRARY_PATH ?? "",
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
  const hostLog = join(homedir(), ".config", "Claude", "logs", "main.log");
  const before = await stat(hostLog);
  const launcher = `import ctypes,os,resource,sys;resource.setrlimit(resource.RLIMIT_CORE,(0,0));libc=ctypes.CDLL(None);libc.prctl(4,0,0,0,0);libc.prctl(1,15,0,0,0);os.execv(sys.argv[1],sys.argv[1:])`;
  keyring = spawn("/usr/bin/python3", ["-c", launcher, "/usr/bin/gnome-keyring-daemon", "--foreground",
    "--components=secrets", "--unlock", `--control-directory=${keyringControl}`], { env: privateEnv, stdio: "pipe" });
  keyring.stdin.end(crypto.randomUUID() + "\n");
  keyring.stdout.resume();
  let keyringErrors = "";
  keyring.stderr.on("data", chunk => { if (keyringErrors.length < 8192) keyringErrors += String(chunk); });
  await Bun.sleep(2000);
  report.keyring = { running: keyring.exitCode === null && keyring.signalCode === null,
    errors: keyringErrors.slice(0, 1000) };
  const bus = Bun.spawn(["/usr/bin/busctl", "--user", "--address", privateEnv.DBUS_SESSION_BUS_ADDRESS,
    "list"], { env: privateEnv, stdout: "pipe", stderr: "pipe" });
  const names = await new Response(bus.stdout).text();
  const busError = await new Response(bus.stderr).text();
  report.service = { exitCode: await bus.exited, secretService: names.includes("org.freedesktop.secrets"),
    stderr: busError.slice(0, 500) };
  const secret = crypto.randomUUID();
  const store = Bun.spawn(["/usr/bin/python3", "-c", launcher, "/usr/bin/timeout", "5s", "/usr/bin/secret-tool", "store", "--label=Orbit disposable pilot",
    "purpose", "orbit-disposable-pilot"], { env: privateEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  store.stdin.write(secret + "\n");
  await store.stdin.end();
  const storeError = await new Response(store.stderr).text();
  const storeCode = await store.exited;
  let matched = false;
  let lookupCode: number | null = null;
  let lookupError = "";
  let lookupLength = 0;
  if (storeCode === 0) {
    const lookup = Bun.spawn(["/usr/bin/python3", "-c", launcher, "/usr/bin/timeout", "5s", "/usr/bin/secret-tool", "lookup", "purpose",
      "orbit-disposable-pilot"], { env: privateEnv, stdout: "pipe", stderr: "pipe" });
    const found = await new Response(lookup.stdout).text();
    lookupError = await new Response(lookup.stderr).text();
    lookupCode = await lookup.exited;
    lookupLength = found.length;
    matched = found.trim() === secret && lookupCode === 0;
  }
  report.secretRoundTrip = { storeCode, lookupCode, lookupLength, matched,
    storeError: storeError.slice(0, 500), lookupError: lookupError.slice(0, 500) };
  const appEnv = Object.entries(privateEnv).map(([key, value]) => `${key}=${value}`);
  try {
    report.launch = await backend.act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/env", "-i", ...appEnv,
      claude, "--ozone-platform=wayland", "--enable-features=UseOzonePlatform",
      "--password-store=gnome-libsecret", "--disable-crash-reporter",
      `--user-data-dir=${join(home, ".config", "Claude")}`] });
  } catch (error) {
    report.launch = { error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code };
  }
  await Bun.sleep(9000);
  const log = join(home, ".config", "Claude", "logs", "main.log");
  const content = await readFile(log, "utf8").catch(() => "");
  report.privateLog = {
    present: content.length > 0,
    basicText: content.includes("basic_text"),
    selectedGnomeBackend: content.includes("backend=gnome_libsecret"),
    falseEncryptionAvailability: content.includes("isEncryptionAvailable=false"),
  };
  report.privateLogFiles = await readdir(join(home, ".config", "Claude", "logs")).catch(() => []);
  report.appAlive = typeof (report.launch as { pid?: number }).pid === "number" &&
    await Bun.file(`/proc/${(report.launch as { pid: number }).pid}/stat`).exists();
  const after = await stat(hostLog);
  report.hostLog = { inodeStable: before.ino === after.ino, sizeBefore: before.size, sizeAfter: after.size };
  report.windows = (await backend.presence()).title;
  await writeFile(join(directory, "pilot-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (keyring && keyring.exitCode === null && keyring.signalCode === null) {
    keyring.kill("SIGTERM");
    await new Promise<void>(resolve => keyring!.once("exit", () => resolve()));
  }
  await backend.close();
}
