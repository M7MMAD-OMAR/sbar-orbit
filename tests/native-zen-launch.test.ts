import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FedoraBackend, nativeSupervisorSafetyFlags, parseNativeAction } from "../src/fedora";
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
  for (const network of [undefined, "offline", "public-web"] as const) {
    const action = parseNativeAction({ type: "launch-app", app: "zen", profile: "active", network });
    expect(nativeSupervisorSafetyFlags(action)).toEqual(["--coredump-filter-zero"]);
  }
  expect(nativeSupervisorSafetyFlags(parseNativeAction({ type: "launch", argv: ["/usr/bin/true"], toolkit: "wayland" })))
    .toEqual([]);
});

test("Zen shared files require an explicit bounded list of canonical paths", () => {
  expect(parseNativeAction({ type: "launch-app", app: "zen", profile: "active", sharedFiles: ["/tmp/notes.txt"] }))
    .toEqual({ type: "launch-app", app: "zen", profile: "active", sharedFiles: ["/tmp/notes.txt"] });
  for (const sharedFiles of [[], ["relative.txt"], ["/tmp/../secret"], ["/tmp//secret"],
    ["/tmp/notes.txt", "/tmp/notes.txt"], Array.from({ length: 17 }, (_, index) => `/tmp/${index}`)])
    expect(() => parseNativeAction({ type: "launch-app", app: "zen", profile: "active", sharedFiles })).toThrow();
});

test("Zen shared files are described without mounting a host directory", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    const document = join(f.root, "notes.txt");
    await writeFile(document, "host copy");
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "offline", [document]);
    expect(prepared.selectedFiles).toEqual([document]);
    expect(prepared.zenFilePolicy?.paths).toEqual([document]);
    expect(prepared.zenFilePolicy?.protectedDirectories).toContain(f.session);
    expect(prepared.zenFilePolicy?.protectedDirectories).toContain(join(f.home, ".var/app/app.zen_browser.zen"));
    expect(prepared.zenSnapshot.hostFiles).toBe("selected-live");
    expect(prepared.zenSnapshot.sharedFiles).toEqual([
      { hostPath: document, privatePath: "/orbit/shared/1/notes.txt" },
    ]);
    expect(prepared.argv).not.toContain(document);
  } finally {
    await prepared?.release();
    f.server.close();
    await rm(f.root, { recursive: true, force: true });
  }
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
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web", [], () => ["https://example.com"]);
    expect(prepared.zenSnapshot.network).toBe("public-web");
    expect(prepared.refusedAuthorities()).toEqual([]);
    const proxyMount = prepared.argv.indexOf("/orbit/zen/runtime/lease.sock");
    expect(proxyMount).toBeGreaterThan(0);
    const leaseSocket = prepared.argv[proxyMount - 1]!;
    expect(leaseSocket.startsWith(f.session)).toBe(true);
    expect((await stat(leaseSocket)).isSocket()).toBe(true);
    expect(prepared.argv).toContain("--unshare-net");
    expect(prepared.argv.some(value => value.includes("/usr/bin/socat"))).toBe(true);
    expect(prepared.argv).not.toContain("LD_PRELOAD");
    expect(prepared.argv).not.toContain("/etc/ld.so.preload");
    expect(prepared.argv).not.toContain("/orbit/no-core/guard.so");
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
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen public web refuses a policy without named origins before copying a profile", async () => {
  const f = await fixture();
  try {
    await expect(prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web"))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await readdir(f.session)).toEqual(["wayland-0"]);
  } finally {
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
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web", [], () => ["https://example.com"]);

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

test("Zen public web preparation removes the lease and clone when copied preferences are unsafe", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.profile, "user.js"), "x".repeat(1024 * 1024 + 1));
    await expect(prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web", [], () => ["https://example.com"]))
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
      { home: f.home, deploymentFiles: f.deploymentFiles }, "public-web", [], () => ["https://example.com"]);
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
    const renderNodes = await readdir("/dev/dri").catch(() => [] as string[]);
    const expectedDevices: string[] = [];
    for (const name of renderNodes.sort()) {
      if (!/^renderD[0-9]+$/.test(name)) continue;
      const node = join("/dev/dri", name);
      const entry = await lstat(node);
      if (entry.isCharacterDevice() && entry.uid === 0) expectedDevices.push(node, node);
    }
    const exposedDevices: string[] = [];
    for (let index = 0; index < prepared.argv.length; index++)
      if (prepared.argv[index] === "--dev-bind")
        exposedDevices.push(prepared.argv[index + 1] ?? "", prepared.argv[index + 2] ?? "");
    expect(exposedDevices).toEqual(expectedDevices);
    expect(prepared.argv).not.toContain("/dev/uinput");
    expect(prepared.argv).not.toContain("/dev/dri/card0");
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
