import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canCloneProfile, detectBrowsers, detectPlatform, passwordStoreFor, profileCookieScheme,
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
  expect(await profileCookieScheme(keyring)).toEqual({ store: "gnome-libsecret", rows: 5 });
  expect(await profileCookieScheme(basic)).toEqual({ store: "basic", rows: 2 });
  // A directory that is not a profile is not an error, it is simply nothing to inherit.
  expect(await profileCookieScheme(join(root, "absent"))).toBeNull();
});

test("the launch store follows the profile, and falls back when no secret service answers", () => {
  expect(passwordStoreFor("gnome-libsecret", "available")).toBe("gnome-libsecret");
  // Asking for a keyring that is not there leaves the browser unable to decrypt and unable to say why.
  expect(passwordStoreFor("gnome-libsecret", "absent")).toBe("basic");
  expect(passwordStoreFor("gnome-libsecret", "unknown")).toBe("basic");
  expect(passwordStoreFor("basic", "available")).toBe("basic");
});

test("the singleton markers are stripped from a copy and the source is never touched", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-singleton-"));
  const source = join(root, "source"), copy = join(root, "copy");
  for (const directory of [source, copy]) {
    await mkdir(directory, { recursive: true });
    for (const marker of singletonMarkers) await writeFile(join(directory, marker), "held");
    await writeFile(join(directory, "Preferences"), "{}");
  }
  expect(await stripSingletonMarkers(copy)).toEqual([...singletonMarkers]);
  expect((await readdir(copy)).sort()).toEqual(["Preferences"]);
  // The person's own browser keeps its lock, or their running browser would be corrupted.
  expect((await readdir(source)).length).toBe(1 + singletonMarkers.length);
  // Stripping a copy that has none is not an error.
  expect(await stripSingletonMarkers(copy)).toEqual([]);
});

test("cloning is refused with a reason for every measured failure mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-clone-gate-"));
  const owned = join(root, "google-chrome"), sandboxed = join(root, "flatpak-chrome");
  await fakeJar(owned, "v11");
  await fakeJar(sandboxed, "v11");
  const install = { id: "google-chrome", executable: "/opt/google/chrome/chrome", packaging: "system" as const,
    profileDirectory: owned, keyringItem: "Chrome Safe Storage" };
  const flatpak = { ...install, packaging: "flatpak" as const, profileDirectory: sandboxed, executable: "/usr/bin/flatpak" };
  const base: PlatformCapabilities = {
    platform: "linux", sessionType: "wayland", desktop: "Hyprland", nativeDisplaySupported: true,
    browserBackendSupported: true, secretService: "available", filteredBusProxy: "/usr/bin/xdg-dbus-proxy",
    systemdUserScopes: true, browsers: [install, flatpak], notes: [],
  };

  const ok = await canCloneProfile(owned, base, root);
  expect(ok.allowed).toBe(true);
  if (ok.allowed) { expect(ok.store).toBe("gnome-libsecret"); expect(ok.install.executable).toBe("/opt/google/chrome/chrome"); }

  // No install owns it, so the binary that could decrypt it is unknown.
  const orphan = await canCloneProfile(join(root, "nobody"), base, root);
  expect(orphan.allowed).toBe(false);
  if (!orphan.allowed) expect(orphan.reason).toContain("No detected browser install");

  // A sandboxed browser asked a portal for its key, so Orbit cannot reach it from outside.
  const sandbox = await canCloneProfile(sandboxed, base, root);
  expect(sandbox.allowed).toBe(false);
  if (!sandbox.allowed) expect(sandbox.reason).toContain("sandbox");

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
  const plainInstall = { ...install, id: "chromium", profileDirectory: plain, keyringItem: "Chromium Safe Storage" };
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
