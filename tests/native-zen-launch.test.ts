import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FedoraBackend, parseNativeAction } from "../src/fedora";
import { discoverZenInstallation, prepareZenLaunch } from "../src/native-zen-launch";

async function fixture() {
  const root = await mkdtemp("/tmp/orbit-zen-launch-");
  const home = join(root, "home");
  const profileBase = join(home, ".var/app/app.zen_browser.zen/config/zen");
  const profile = join(profileBase, "Profiles", "fixture.default");
  const deploymentFiles = join(root, "deployment", "files");
  const session = join(root, "session");
  const libraries = join(root, "libraries");
  await mkdir(profile, { recursive: true });
  await mkdir(join(deploymentFiles, "zen"), { recursive: true });
  await mkdir(session, { mode: 0o700 });
  await mkdir(libraries);
  await writeFile(join(profileBase, "profiles.ini"),
    "[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/fixture.default\nDefault=1\n[Installfixture]\nDefault=Profiles/fixture.default\n");
  await writeFile(join(deploymentFiles, "zen", "zen"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const wayland = join(session, "wayland-0");
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(wayland, resolve));
  return { root, home, profileBase, profile, deploymentFiles, session, libraries, wayland, server };
}

test("Zen launch-app accepts no caller paths or executable arguments", () => {
  expect(parseNativeAction({ type: "launch-app", app: "zen", profile: "active" }))
    .toEqual({ type: "launch-app", app: "zen", profile: "active" });
  for (const extra of [
    { argv: ["/usr/bin/zen"] }, { sourceProfile: "/tmp/other" }, { url: "https://example.com" },
    { openPath: "/tmp/file" }, { extensions: [] },
  ]) expect(() => parseNativeAction({ type: "launch-app", app: "zen", profile: "active", ...extra })).toThrow();
  expect(parseNativeAction({ type: "launch-app", app: "zen", profile: "active", network: "public-web" }))
    .toEqual({ type: "launch-app", app: "zen", profile: "active", network: "public-web" });
  expect(() => parseNativeAction({ type: "launch-app", app: "zen", profile: "active", network: "any" })).toThrow();
});

test("one private display refuses a second Zen profile copy", async () => {
  const backend = Object.assign(Object.create(FedoraBackend.prototype), {
    parseAction: parseNativeAction, closed: false, children: [], zenLaunchReserved: true,
  }) as FedoraBackend;
  await expect(backend.act({ type: "launch-app", app: "zen", profile: "active" }))
    .rejects.toMatchObject({ code: "LIMIT_REACHED" });
});

test("Zen public web mode mounts only its lease socket and writes proxy preferences to the clone", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    const outside = join(f.root, "outside-user-js");
    await writeFile(outside, "outside stays unchanged\n");
    await symlink(outside, join(f.profile, "user.js"));
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web");
    expect(prepared.zenSnapshot.network).toBe("public-web");
    const proxyMount = prepared.argv.indexOf("/orbit/zen/runtime/lease.sock");
    expect(proxyMount).toBeGreaterThan(0);
    const leaseSocket = prepared.argv[proxyMount - 1]!;
    expect(leaseSocket.startsWith(f.session)).toBe(true);
    expect((await stat(leaseSocket)).isSocket()).toBe(true);
    expect(prepared.argv).toContain("--unshare-net");
    expect(prepared.argv.some(value => value.includes("/usr/bin/socat"))).toBe(true);
    const guardMount = prepared.argv.indexOf("/orbit/no-core/guard.so");
    expect(guardMount).toBeGreaterThan(0);
    expect((await stat(prepared.argv[guardMount - 1]!)).isFile()).toBe(true);
    expect(prepared.argv).toContain("LD_PRELOAD");
    expect(prepared.argv).toContain("/orbit/no-core/guard.so");
    expect(prepared.argv).toContain("ORBIT_NO_CORE_PROOFS");
    expect(prepared.argv.some(value => value.includes("pid-$bridge"))).toBe(true);
    const privatePreload = prepared.argv.indexOf("/etc/ld.so.preload");
    expect(privatePreload).toBeGreaterThan(0);
    expect(await readFile(prepared.argv[privatePreload - 1]!, "utf8"))
      .toBe("/orbit/no-core/guard.so\n");
    const guardDirectory = prepared.argv[guardMount - 1]!.split("/guard.so")[0]!;
    expect(prepared.argv).not.toContain(f.profile);
    const profileInside = prepared.argv.at(-1)!;
    const cloneDirectory = prepared.argv[prepared.argv.indexOf("/orbit/zen") - 1]!;
    const clonedPrefs = join(cloneDirectory, profileInside.split("/").at(-1)!, "user.js");
    expect((await lstat(clonedPrefs)).isFile()).toBe(true);
    const prefs = await readFile(clonedPrefs, "utf8");
    expect(prefs).toContain('user_pref("network.proxy.type", 1)');
    expect(prefs).toContain('user_pref("network.proxy.ssl", "127.0.0.1")');
    expect(prefs).toContain('user_pref("network.proxy.ssl_port", 8888)');
    expect(prefs).toContain('user_pref("network.proxy.allow_hijacking_localhost", true)');
    expect(await readFile(outside, "utf8")).toBe("outside stays unchanged\n");
    await prepared.release();
    prepared = undefined;
    expect(await stat(leaseSocket).then(() => true, () => false)).toBe(false);
    expect(await stat(cloneDirectory).then(() => true, () => false)).toBe(false);
    expect(await stat(guardDirectory).then(() => true, () => false)).toBe(false);
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen public web mode removes only the copied Mozilla account and overrides Sync after proxy prefs", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    const sourceAccount = '{"version":1,"accountData":{"uid":"synthetic","sessionToken":"synthetic"}}';
    const sourcePrefs = 'user_pref("services.sync.username", "synthetic");\n';
    await writeFile(join(f.profile, "signedInUser.json"), sourceAccount);
    await writeFile(join(f.profile, "user.js"), sourcePrefs);
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web");

    const cloneDirectory = prepared.argv[prepared.argv.indexOf("/orbit/zen") - 1]!;
    const profileInside = prepared.argv.at(-1)!;
    const cloneProfile = join(cloneDirectory, profileInside.split("/").at(-1)!);
    const prefs = await readFile(join(cloneProfile, "user.js"), "utf8");
    expect(await Bun.file(join(cloneProfile, "signedInUser.json")).exists()).toBe(false);
    expect(prefs).toContain('user_pref("network.proxy.type", 1)');
    expect(prefs.lastIndexOf('user_pref("services.sync.username", "");'))
      .toBeGreaterThan(prefs.indexOf('user_pref("network.proxy.type", 1)'));
    expect(prefs.trimEnd().endsWith('user_pref("services.sync.username", "");')).toBe(true);
    expect(await readFile(join(f.profile, "signedInUser.json"), "utf8")).toBe(sourceAccount);
    expect(await readFile(join(f.profile, "user.js"), "utf8")).toBe(sourcePrefs);
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen public web mode fails closed when the guard compiler is absent", async () => {
  const f = await fixture();
  try {
    await expect(prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles, guardCompiler: join(f.root, "missing-cc") }, "public-web"))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await readdir(f.session)).toEqual(["wayland-0"]);
  } finally {
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen public web guard runs after exec and records the synthetic child PID", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web");
    const guardMount = prepared.argv.indexOf("/orbit/no-core/guard.so");
    const library = prepared.argv[guardMount - 1]!;
    const cloneDirectory = prepared.argv[prepared.argv.indexOf("/orbit/zen") - 1]!;
    const proofs = join(cloneDirectory, "runtime", "no-core-proofs");
    const source = join(f.root, "synthetic.c");
    const executable = join(f.root, "synthetic");
    await writeFile(source, '#include <stdio.h>\n#include <unistd.h>\n#include <sys/prctl.h>\nint main(void) { printf("pid=%ld dumpable=%d\\n", (long)getpid(), prctl(PR_GET_DUMPABLE)); return 0; }\n');
    const compiler = Bun.spawn(["/usr/bin/cc", "-o", executable, source], { stdout: "ignore", stderr: "ignore" });
    expect(await compiler.exited).toBe(0);
    const child = Bun.spawn([executable], {
      env: { ...process.env, LD_PRELOAD: library, ORBIT_NO_CORE_PROOFS: proofs },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const match = /^pid=(\d+) dumpable=0\n$/.exec(output);
    expect(match).not.toBeNull();
    expect(await readFile(join(proofs, `pid-${match?.[1]}`), "utf8"))
      .toBe(`pid=${match?.[1]}\ndumpable=0\nexe=${executable}\n`);
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen private loader protects an exec that clears LD_PRELOAD", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web");
    const command = "import ctypes,os; print('pid=%d dumpable=%d preload_env=%d' % (os.getpid(), ctypes.CDLL(None).prctl(3), int('LD_PRELOAD' in os.environ)))";
    const child = Bun.spawn([...prepared.argv.slice(0, -8), "/usr/bin/env", "-i", "/usr/bin/python3", "-c", command],
      { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output).toMatch(/^pid=\d+ dumpable=0 preload_env=0\n$/);
    const cloneDirectory = prepared.argv[prepared.argv.indexOf("/orbit/zen") - 1]!;
    const proofNames = await readdir(join(cloneDirectory, "runtime", "no-core-proofs"));
    expect(proofNames.some(name => /^pid-\d+$/.test(name))).toBe(true);
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen public web preparation removes the lease and clone when copied preferences are unsafe", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.profile, "user.js"), "x".repeat(1024 * 1024 + 1));
    await expect(prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web"))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await readdir(f.session)).toEqual(["wayland-0"]);
  } finally {
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen launch preflight failure closes the public web lease and removes the copied profile", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web");
    const backend = Object.assign(Object.create(FedoraBackend.prototype), {
      parseAction: parseNativeAction, closed: false, children: [], zenLaunchReserved: false,
      directory: f.session, waylandDisplay: "wayland-0", env: { LD_LIBRARY_PATH: f.libraries },
      prepareZen: async () => ({ ...prepared!, argv: ["/orbit/nonexistent-zen-executable"] }),
    }) as FedoraBackend;
    await expect(backend.act({ type: "launch-app", app: "zen", profile: "active", network: "public-web" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    prepared = undefined;
    expect(await readdir(f.session)).toEqual(["wayland-0"]);
    expect((backend as unknown as { zenLaunchReserved: boolean }).zenLaunchReserved).toBe(false);
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen launcher discovers its own profile and prepares an offline mount root", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    const install = await discoverZenInstallation({ home: f.home, deploymentFiles: f.deploymentFiles });
    expect(install.profile).toBe(f.profile);
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles });
    expect(prepared.zenSnapshot.network).toBe("offline");
    expect(prepared.zenSnapshot.hostFiles).toBe("unavailable");
    expect(prepared.argv).toContain("--unshare-net");
    expect(prepared.argv).toContain("--clearenv");
    expect(prepared.argv).not.toContain("LD_PRELOAD");
    expect(prepared.argv).not.toContain("/orbit/no-core/guard.so");
    expect(prepared.argv).not.toContain("/etc/ld.so.preload");
    expect(prepared.argv).toContain("--dev");
    expect(prepared.argv).not.toContain("--dev-bind");
    expect(prepared.argv).not.toContain("/");
    expect(prepared.argv).not.toContain(f.profile);
    expect(prepared.argv).not.toContain(f.home);
    expect(prepared.argv.at(-4)).toBe("/app/zen/zen");
    expect(prepared.argv.at(-3)).toBe("--no-remote");
    expect(prepared.argv.at(-2)).toBe("--profile");
    expect(prepared.argv.at(-1)?.startsWith("/orbit/zen/zen-profile-")).toBe(true);
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen discovery rejects a default profile outside its Flatpak state", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.profileBase, "profiles.ini"), "[Installfixture]\nDefault=../../../../outside\n");
    await expect(discoverZenInstallation({ home: f.home, deploymentFiles: f.deploymentFiles })).rejects.toThrow();
    expect(await readdir(f.session)).toEqual(["wayland-0"]);
  } finally {
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});
