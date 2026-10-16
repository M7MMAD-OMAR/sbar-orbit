import { linuxOnlySuite, needsCommand } from "./platform-support";
import { expect, test as schemaTest } from "bun:test";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FedoraBackend, nativeSupervisorSafetyFlags, parseNativeAction } from "../src/fedora";
import { discoverZenInstallation, prepareZenLaunch } from "../src/native-zen-launch";

const nativeTest = linuxOnlySuite("native Flatpak Zen launch uses Linux bubblewrap and Wayland sockets");
const test = process.platform !== "linux" ? nativeTest : needsCommand("bwrap", "Zen launch preparation needs bubblewrap");

async function fixture(homeName = "home") {
  const root = await mkdtemp("/tmp/orbit-zen-launch-");
  const home = join(root, homeName);
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

async function withFlatpakEnvironment(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const names = ["XDG_DATA_HOME", "FLATPAK_USER_DIR", "FLATPAK_SYSTEM_DIR"];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await run();
  } finally {
    for (const [index, name] of names.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

nativeTest("Zen local installation prepares a copied profile without Flatpak", async () => {
  const f = await fixture("local user home");
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    await rm(join(f.home, ".var"), { recursive: true });
    const appRoot = join(f.home, ".zen");
    const profile = join(appRoot, "fixture.default");
    const executableDirectory = join(f.home, ".local/share/zen");
    await mkdir(profile, { recursive: true });
    await mkdir(executableDirectory, { recursive: true });
    await writeFile(join(appRoot, "profiles.ini"), "[Installfixture]\nDefault=fixture.default\n");
    await writeFile(join(executableDirectory, "zen"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await discoverZenInstallation({ home: f.home })).toEqual({
      deploymentFiles: executableDirectory, executableDirectory, profile, appRoot,
    });
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries, { home: f.home });
    expect(prepared.argv).toContain("/app/zen/zen");
    const binding = prepared.argv.indexOf(executableDirectory);
    expect(prepared.argv[binding - 1]).toBe("--ro-bind");
    expect(prepared.argv[binding + 1]).toBe("/app/zen");
    expect(prepared.argv).not.toContain(profile);
    expect(prepared.zenSnapshot.network).toBe("offline");
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

nativeTest("Zen local discovery rejects a profile outside its application data", async () => {
  const f = await fixture();
  try {
    await rm(join(f.home, ".var"), { recursive: true });
    const appRoot = join(f.home, ".zen");
    await mkdir(appRoot);
    await writeFile(join(appRoot, "profiles.ini"), "[Installfixture]\nDefault=../outside\n");
    await mkdir(join(f.home, "outside"));
    await expect(discoverZenInstallation({ home: f.home })).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Zen active profile must be a real directory inside its installation",
    });
  } finally {
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

nativeTest("Zen discovery follows a moved executable registered on PATH", async () => {
  const f = await fixture("another account");
  try {
    await rm(join(f.home, ".var"), { recursive: true });
    const appRoot = join(f.home, ".zen");
    const profile = join(appRoot, "fixture.default");
    const executableDirectory = join(f.root, "relocated stable archive");
    const bin = join(f.home, "bin");
    await mkdir(profile, { recursive: true });
    await mkdir(executableDirectory);
    await mkdir(bin);
    await writeFile(join(appRoot, "profiles.ini"), "[Installfixture]\nDefault=fixture.default\n");
    await writeFile(join(executableDirectory, "zen"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await symlink(join(executableDirectory, "zen"), join(bin, "zen"));
    const result = await discoverZenInstallation({ home: f.home,
      discovery: { env: { PATH: bin, HOME: f.home }, includeRunning: false, applicationDirectories: [] } } as Parameters<typeof discoverZenInstallation>[0]);
    expect(result).toEqual({ deploymentFiles: executableDirectory, executableDirectory, profile, appRoot });
  } finally {
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

nativeTest("Zen uses an explicit running profile instead of guessing profiles.ini", async () => {
  const f = await fixture();
  try {
    await rm(join(f.home, ".var"), { recursive: true });
    const executableDirectory = join(f.root, "active archive");
    const profile = join(f.home, "explicit profile");
    const proc = join(f.root, "processes");
    await mkdir(executableDirectory); await mkdir(profile); await mkdir(join(proc, "123"), { recursive: true });
    const executable = join(executableDirectory, "zen");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await symlink(executable, join(proc, "123/exe"));
    await writeFile(join(proc, "123/cmdline"), [executable, "--profile", profile].join("\0"));
    const result = await discoverZenInstallation({ home: f.home,
      discovery: { env: { HOME: f.home, PATH: "" }, procRoot: proc, includeRunning: true, applicationDirectories: [] } });
    expect(result).toEqual({ deploymentFiles: executableDirectory, executableDirectory, profile, appRoot: profile });
  } finally {
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const layout of ["xdg", "default", "empty-xdg", "relative-xdg", "user-override", "system-override"] as const) {
  nativeTest(`Zen stable discovery uses a disposable home with spaces and ${layout} Flatpak data`, async () => {
    const f = await fixture("external user home");
    try {
      const dataHome = join(f.root, "external data directory");
      const userRoot = layout === "user-override" ? join(f.root, "user installation") :
        join(layout === "xdg" ? dataHome : join(f.home, ".local/share"), "flatpak");
      const systemRoot = join(f.root, "system installation");
      const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
      const stable = join(layout === "system-override" ? systemRoot : userRoot,
        "app/app.zen_browser.zen", architecture, "stable");
      const files = join(stable, "fixture-deployment/files");
      await mkdir(join(files, "zen"), { recursive: true });
      await writeFile(join(files, "zen/zen"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink("fixture-deployment", join(stable, "active"));
      await withFlatpakEnvironment({
        FLATPAK_SYSTEM_DIR: systemRoot,
        FLATPAK_USER_DIR: layout === "user-override" ? userRoot : undefined,
        XDG_DATA_HOME: layout === "xdg" || layout === "user-override" ? dataHome :
          layout === "empty-xdg" ? "" : layout === "relative-xdg" ? "relative-data" : undefined,
      }, async () => {
        expect(await discoverZenInstallation({ home: f.home })).toEqual({
          deploymentFiles: files, profile: f.profile,
          appRoot: join(f.home, ".var/app/app.zen_browser.zen"),
        });
      });
    } finally {
      await new Promise<void>(resolve => f.server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const layout of ["ambiguous", "alias"] as const) {
  nativeTest(`Zen stable discovery handles ${layout} system and user deployments`, async () => {
    const f = await fixture("external user home");
    try {
      const dataHome = join(f.root, "external data directory");
      const systemRoot = join(f.root, "system installation");
      const userRoot = join(dataHome, "flatpak");
      const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
      const deploymentPath = join("app/app.zen_browser.zen", architecture, "stable/active/files");
      const systemFiles = join(systemRoot, deploymentPath);
      await mkdir(join(systemFiles, "zen"), { recursive: true });
      await writeFile(join(systemFiles, "zen/zen"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await mkdir(dataHome);
      if (layout === "alias") await symlink(systemRoot, userRoot);
      else {
        const userFiles = join(userRoot, deploymentPath);
        await mkdir(join(userFiles, "zen"), { recursive: true });
        await writeFile(join(userFiles, "zen/zen"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      await withFlatpakEnvironment({ XDG_DATA_HOME: dataHome, FLATPAK_SYSTEM_DIR: systemRoot }, async () => {
        if (layout === "ambiguous") {
          await expect(discoverZenInstallation({ home: f.home })).rejects.toMatchObject({
            code: "UNSUPPORTED",
            message: "Zen stable Flatpak deployment is ambiguous between system and user installations",
          });
        } else {
          expect((await discoverZenInstallation({ home: f.home })).deploymentFiles).toBe(systemFiles);
        }
        expect((await discoverZenInstallation({ home: f.home, deploymentFiles: systemFiles })).deploymentFiles)
          .toBe(systemFiles);
      });
    } finally {
      await new Promise<void>(resolve => f.server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

schemaTest("Zen launch-app accepts no caller paths or executable arguments", () => {
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

schemaTest("Zen shared files require an explicit bounded list of canonical paths", () => {
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
  const f = await fixture("external user home");
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

for (const idleLocal of [false, true]) {
  nativeTest(`running Flatpak Zen retains its deployment and profile with idle local profile ${idleLocal}`, async () => {
    const f = await fixture();
    try {
      const userRoot = join(f.root, "flatpak installation");
      const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
      const files = join(userRoot, "app/app.zen_browser.zen", arch, "stable/commit/files");
      await mkdir(join(files, "zen"), { recursive: true });
      const executable = join(files, "zen/zen-bin");
      await writeFile(executable, "fixture", { mode: 0o755 });
      await writeFile(join(files, "zen/zen"), "fixture", { mode: 0o755 });
      const proc = join(f.root, "proc"); await mkdir(join(proc, "123"), { recursive: true });
      await symlink(executable, join(proc, "123/exe"));
      if (idleLocal) {
        await mkdir(join(f.home, ".zen/idle"), { recursive: true });
        await writeFile(join(f.home, ".zen/profiles.ini"), "[Installfixture]\nDefault=idle\n");
      }
      const discovery = { env: { HOME: f.home, PATH: "", FLATPAK_USER_DIR: userRoot },
        includeRunning: true, procRoot: proc, applicationDirectories: [] };
      const result = await discoverZenInstallation({ home: f.home, discovery });
      expect(result.deploymentFiles).toBe(files); expect(result.profile).toBe(f.profile);
      expect(result.executableDirectory).toBeUndefined();
    } finally {
      await new Promise<void>(resolve => f.server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const selector of ["named", "relative", "unavailable", "empty"] as const) {
  nativeTest(`Zen running ${selector} selector never silently chooses the default profile`, async () => {
    const f = await fixture();
    try {
      await rm(join(f.home, ".var"), { recursive: true });
      const base = join(f.home, ".zen");
      const selected = join(base, "selected");
      await mkdir(selected, { recursive: true }); await mkdir(join(base, "default"));
      await writeFile(join(base, "profiles.ini"), "[Installfixture]\nDefault=default\n[Profile0]\nName=default\nPath=default\nDefault=1\n[Profile1]\nName=Selected\nPath=selected\n");
      const archive = join(f.home, ".local/share/zen"); await mkdir(archive, { recursive: true });
      const executable = join(archive, "zen"); await writeFile(executable, "fixture", { mode: 0o755 });
      const proc = join(f.root, "proc"); await mkdir(join(proc, "123"), { recursive: true });
      await symlink(executable, join(proc, "123/exe")); await symlink(base, join(proc, "123/cwd"));
      await writeFile(join(proc, "123/cmdline"), [executable, ...(selector === "named" ? ["-P", "Selected"] : selector === "empty" ? ["--profile="] : ["--profile", selector === "relative" ? "selected" : "missing"])].join("\0"));
      const location = { home: f.home, discovery: { env: { HOME: f.home, PATH: "" }, includeRunning: true, procRoot: proc, applicationDirectories: [] } };
      if (selector === "unavailable" || selector === "empty") await expect(discoverZenInstallation(location)).rejects.toThrow("default fallback is refused");
      else expect((await discoverZenInstallation(location)).profile).toBe(selected);
    } finally {
      await new Promise<void>(resolve => f.server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
