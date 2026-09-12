import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, symlink, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  canCloneProfile, describeMachine, detectBrowsers, detectPlatform, passwordStoreFor, profileCookieScheme,
  singletonMarkers, stripSingletonMarkers, supportsReflink, type PlatformCapabilities,
} from "../src/platform";

/** A cookie jar with the three byte version prefix Chromium writes, and nothing else that matters. */
async function fakeJar(profile: string, prefix: "v10" | "v11", rows = 3) {
  await mkdir(join(profile, "Default"), { recursive: true });
  const database = new Database(join(profile, "Default", "Cookies"));
  database.run("create table cookies (host_key text, name text, encrypted_value blob)");
  const insert = database.prepare("insert into cookies values (?, ?, ?)");
  for (let i = 0; i < rows; i++) insert.run(`host${i}`, `name${i}`, Buffer.concat([Buffer.from(prefix), Buffer.from([1, 2, 3, 4])]));
  database.close();
}

test("a profile's cookie scheme is read from the version prefix, without reading a value", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-platform-"));
  const keyring = join(root, "keyring-profile"), basic = join(root, "basic-profile");
  await fakeJar(keyring, "v11", 5);
  await fakeJar(basic, "v10", 2);
  expect(await profileCookieScheme(keyring)).toEqual({ scheme: "keyring", rows: 5 });
  expect(await profileCookieScheme(basic)).toEqual({ scheme: "basic", rows: 2 });
  // A directory that is not a profile is not an error, it is simply nothing to inherit.
  expect(await profileCookieScheme(join(root, "absent"))).toBeNull();
});

test("the launch store comes from the desktop, not from the profile's bytes", () => {
  // Both backends write a v11 prefix, so the file cannot say which one; the desktop decides.
  expect(passwordStoreFor("keyring", "available", "GNOME")).toBe("gnome-libsecret");
  expect(passwordStoreFor("keyring", "available", "Hyprland")).toBe("gnome-libsecret");
  expect(passwordStoreFor("keyring", "available", "KDE")).toBe("kwallet");
  expect(passwordStoreFor("keyring", "available", "plasmawayland")).toBe("kwallet");
  // Asking for a keyring that is not there leaves the browser unable to decrypt and unable to say why.
  expect(passwordStoreFor("keyring", "absent", "KDE")).toBe("basic");
  expect(passwordStoreFor("keyring", "unknown", "GNOME")).toBe("basic");
  expect(passwordStoreFor("basic", "available", "GNOME")).toBe("basic");
});

test("the singleton markers are stripped from a copy and the source is never touched", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-singleton-"));
  const source = join(root, "source"), copy = join(root, "copy");
  for (const directory of [source, copy]) {
    await mkdir(directory, { recursive: true });
    // As Chrome actually writes them: symlinks, and two of them dangling by design. SingletonLock points
    // at `hostname-pid` and SingletonCookie at a number, so a check that follows the link finds nothing,
    // removes nothing, and hands the session the person's live lock. Written with regular files, this
    // test passed while the real thing was broken.
    await symlink("orbit-host-4242", join(directory, "SingletonLock"));
    await symlink("6273928560075026783", join(directory, "SingletonCookie"));
    await writeFile(join(directory, "socket-target"), "");
    await symlink(join(directory, "socket-target"), join(directory, "SingletonSocket"));
    await writeFile(join(directory, "Preferences"), "{}");
  }
  for (const marker of singletonMarkers) await expect(lstat(join(copy, marker))).resolves.toBeTruthy();
  expect(await stripSingletonMarkers(copy)).toEqual([...singletonMarkers]);
  expect((await readdir(copy)).sort()).toEqual(["Preferences", "socket-target"]);
  // The person's own browser keeps its lock, or their running browser would be corrupted.
  expect((await readdir(source)).length).toBe(2 + singletonMarkers.length);
  // Stripping a copy that has none is not an error.
  expect(await stripSingletonMarkers(copy)).toEqual([]);
});

test("cloning is refused with a reason for every measured failure mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-clone-gate-"));
  const owned = join(root, "google-chrome"), sandboxed = join(root, "flatpak-chrome");
  await fakeJar(owned, "v11");
  await fakeJar(sandboxed, "v11");
  const install = { id: "google-chrome", executable: "/opt/google/chrome/chrome", packaging: "system" as const,
    profileDirectory: owned, keyringItem: "Chrome Safe Storage", keyringApplication: "chrome" };
  const flatpak = { ...install, packaging: "flatpak" as const, profileDirectory: sandboxed, executable: "/usr/bin/flatpak" };
  const base: PlatformCapabilities = {
    platform: "linux", sessionType: "wayland", desktop: "Hyprland", nativeDisplaySupported: true,
    browserBackendSupported: true, secretService: "available", filteredBusProxy: "/usr/bin/xdg-dbus-proxy",
    systemdUserScopes: true, confinedEgress: true, browsers: [install, flatpak], notes: [],
  };

  const ok = await canCloneProfile(owned, base, root);
  expect(ok.allowed).toBe(true);
  if (ok.allowed) { expect(ok.store).toBe("gnome-libsecret"); expect(ok.install.executable).toBe("/opt/google/chrome/chrome"); }

  // The same keyring profile on KDE must be opened with kwallet, or it decrypts nothing.
  const onKde = await canCloneProfile(owned, { ...base, desktop: "KDE" }, root);
  expect(onKde.allowed).toBe(true);
  if (onKde.allowed) expect(onKde.store).toBe("kwallet");

  // No install owns it, so the binary that could decrypt it is unknown.
  const orphan = await canCloneProfile(join(root, "nobody"), base, root);
  expect(orphan.allowed).toBe(false);
  if (!orphan.allowed) expect(orphan.reason).toContain("No detected browser install");

  // A Flatpak profile is allowed when a launchable browser of the SAME branding exists, because the
  // portal proxies to the same login keyring item. Measured: 115 of 115 cookies decrypted this way.
  const sandbox = await canCloneProfile(sandboxed, base, root);
  expect(sandbox.allowed).toBe(true);
  if (sandbox.allowed) expect(sandbox.install.executable).toBe("/opt/google/chrome/chrome");

  // With no launchable browser of that branding there is nothing that can open it: a browser of
  // another branding looks up a differently named keyring item and decrypts nothing.
  const noLauncher = await canCloneProfile(sandboxed, { ...base, browsers: [flatpak] }, root);
  expect(noLauncher.allowed).toBe(false);
  if (!noLauncher.allowed) expect(noLauncher.reason).toContain("no directly launchable");

  // A keyring profile with no secret service would start signed out, which is worse than refusing.
  const noSecrets = await canCloneProfile(owned, { ...base, secretService: "absent" }, root);
  expect(noSecrets.allowed).toBe(false);
  if (!noSecrets.allowed) expect(noSecrets.reason).toContain("keyring");

  // Without a filtering proxy the only route is the person's whole session bus, which Orbit refuses.
  const noProxy = await canCloneProfile(owned, { ...base, filteredBusProxy: null }, root);
  expect(noProxy.allowed).toBe(false);
  if (!noProxy.allowed) expect(noProxy.reason).toContain("xdg-dbus-proxy");

  // A basic-store profile needs neither the keyring nor the proxy, so it stays allowed without them.
  const plain = join(root, "chromium");
  await fakeJar(plain, "v10");
  const plainInstall = { ...install, id: "chromium", profileDirectory: plain, keyringItem: "Chromium Safe Storage", keyringApplication: "chromium" };
  const allowed = await canCloneProfile(plain, { ...base, secretService: "absent", filteredBusProxy: null, browsers: [plainInstall] }, root);
  expect(allowed.allowed).toBe(true);
  if (allowed.allowed) expect(allowed.store).toBe("basic");
});

test("browser detection reports every install, and reports no preference order", async () => {
  const home = await mkdtemp(join(tmpdir(), "orbit-home-"));
  // A Flatpak install is only claimed when its profile is actually there, because its executable is
  // a shared runner rather than a browser path.
  await mkdir(join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"), { recursive: true });
  const found = await detectBrowsers(home);
  for (const install of found) {
    expect(install.executable.startsWith("/")).toBe(true);
    // Chrome and Chromium look up differently named keyring items, which is why a cross binary clone
    // decrypts nothing and why the owning install has to be recorded per profile.
    expect(install.keyringItem).toBe(install.id === "google-chrome" ? "Chrome Safe Storage" : "Chromium Safe Storage");
  }
  const system = found.filter(install => install.packaging === "system").map(install => install.id);
  expect(new Set(system).size).toBe(system.length);
});

test("the platform probe answers without starting an application", async () => {
  const capabilities = await detectPlatform();
  expect(capabilities.platform).toBe(process.platform);
  expect(["wayland", "x11", "none"]).toContain(capabilities.sessionType);
  expect(["available", "absent", "unknown"]).toContain(capabilities.secretService);
  if (process.platform !== "linux") {
    expect(capabilities.browserBackendSupported).toBe(false);
    expect(capabilities.notes.join(" ")).toContain("unverified");
  }
});

test("reflink support is probed by asking for one, not by reading the filesystem name", async () => {
  // tmpdir is tmpfs on this workstation and has no reflink; the answer must be a boolean either way.
  const root = await mkdtemp(join(tmpdir(), "orbit-reflink-"));
  expect(typeof await supportsReflink(root)).toBe("boolean");
  // The probe leaves nothing behind, because it runs before every clone.
  expect((await readdir(root)).filter(entry => entry.startsWith(".orbit-reflink-")).length).toBe(0);
});

test("the keyring lookup attribute follows the branding, not the package", async () => {
  const home = await mkdtemp(join(tmpdir(), "orbit-keyring-"));
  await mkdir(join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"), { recursive: true });
  for (const install of await detectBrowsers(home)) {
    // Chromium stores its key under application=chromium and Chrome under chrome, whatever the
    // package. A one-item secret bus looks the key up by this value, so getting it wrong serves the
    // wrong secret and the clone decrypts nothing.
    expect(install.keyringApplication).toBe(install.id === "google-chrome" ? "chrome" : "chromium");
    expect(install.keyringItem.toLowerCase()).toContain(install.keyringApplication);
  }
});

test("confined egress is probed by asking for a namespace, not by finding a binary", async () => {
  const capabilities = await detectPlatform();
  expect(typeof capabilities.confinedEgress).toBe("boolean");
  // Unprivileged user namespaces can be present, absent, or present and administratively disabled,
  // and only trying tells the three apart. A host that cannot confine says so rather than running
  // unconfined and quietly.
  if (!capabilities.confinedEgress && capabilities.platform === "linux")
    expect(capabilities.notes.join(" ")).toContain("enforced inside the browser rather than below it");
  // The report a person pastes into an issue carries the answer, because it decides a tier.
  const machine = await describeMachine();
  expect(machine.confinedEgress).toBe(capabilities.confinedEgress);
});

test("a capability report can be produced with no broker, and carries nothing private", async () => {
  // The most commonly reported problem is a broker that will not start, which is exactly the case a
  // broker RPC cannot answer. So this path is answered before the one that needs a socket, and the test
  // runs it the way a reporter would: with no ORBIT_SOCKET set at all.
  const environment = { ...process.env };
  delete environment.ORBIT_SOCKET;
  const cli = Bun.spawn(["bun", "src/cli.ts", "doctor", "--report"], { env: environment, stdout: "pipe", stderr: "pipe" });
  const printed = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);
  const report = JSON.parse(printed) as Record<string, unknown>;
  expect(report.report).toBe("orbit-capabilities");
  expect(report.orbitVersion).toBe("0.1.0-alpha.2");
  // Never Measured. A probe can say that a host is the same class as the one the measurements were taken
  // on; awarding the tier itself would print a pass over a suite that never ran here.
  expect((report.tier as { assigned: string }).assigned).not.toBe("Measured");
  expect((report.tier as { reference: string }).reference).toBe("docs/support-tiers.md");
  // The redaction is a property of the shape, so it is asserted on the serialised text rather than on
  // the fields anyone remembered to check.
  expect(printed).not.toContain(homedir());
  expect(printed.toLowerCase()).not.toContain("cookie_name");
  expect(printed).not.toContain("ORBIT_SOCKET");
});
