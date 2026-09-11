import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { cloneProfile } from "../src/clone";
import { parsePolicy, freshProfilePolicy } from "../src/policy";
import type { PlatformCapabilities } from "../src/platform";

/** A profile shaped like Chrome's, with a v10 jar so no keyring is needed to exercise the path. */
async function fixtureProfile(root: string, name: string) {
  const profile = join(root, name);
  await mkdir(join(profile, "Default"), { recursive: true });
  const database = new Database(join(profile, "Default", "Cookies"));
  database.run("create table cookies (host_key text, name text, encrypted_value blob)");
  database.prepare("insert into cookies values (?, ?, ?)").run("host", "n", Buffer.concat([Buffer.from("v10"), Buffer.from([9, 9])]));
  database.close();
  await writeFile(join(profile, "Preferences"), JSON.stringify({ profile: { name } }));
  await mkdir(join(profile, "Default", "Extensions", "abc"), { recursive: true });
  // A copy taken from a running browser carries these, and Chrome then refuses to start.
  for (const marker of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await writeFile(join(profile, marker), "held");
  return profile;
}

function capabilitiesFor(profile: string): PlatformCapabilities {
  return {
    platform: "linux", sessionType: "wayland", desktop: "Hyprland", nativeDisplaySupported: true,
    browserBackendSupported: true, secretService: "available", filteredBusProxy: "/usr/bin/xdg-dbus-proxy",
    systemdUserScopes: true, notes: [],
    browsers: [{ id: "google-chrome", executable: "/opt/google/chrome/chrome", packaging: "system", profileDirectory: profile, keyringItem: "Chrome Safe Storage" }],
  };
}

const bounded = parsePolicy({ mode: "autonomous", origins: ["https://example.test"], allow: ["read", "navigate", "write"] });

test("a clone carries the profile, drops the locks, and never writes to the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-clone-"));
  const source = await fixtureProfile(root, "google-chrome");
  const before = {
    entries: (await readdir(source)).sort(),
    preferences: await readFile(join(source, "Preferences"), "utf8"),
    cookieSize: (await stat(join(source, "Default", "Cookies"))).size,
    modified: (await stat(join(source, "Preferences"))).mtimeMs,
  };
  const session = join(root, "session-profile");
  await mkdir(session, { recursive: true });

  const result = await cloneProfile(source, session, bounded, capabilitiesFor(source));
  // The launcher must be told the owning binary and the right store, or the clone starts signed out.
  expect(result.launch.executable).toBe("/opt/google/chrome/chrome");
  expect(result.launch.passwordStore).toBe("basic");
  // The person's own extensions are part of what was asked for, and Chrome disables them by default.
  expect(result.launch.extensions).toBe(true);
  // A v10 jar needs no keyring, so no bus is spawned and none has to be torn down.
  expect(result.launch.sessionBus).toBeUndefined();

  // The clone has the profile and none of the locks.
  const cloned = (await readdir(session)).sort();
  expect(cloned).toContain("Preferences");
  expect(cloned).toContain("Default");
  for (const marker of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) expect(cloned).not.toContain(marker);
  expect(await readFile(join(session, "Preferences"), "utf8")).toBe(before.preferences);
  expect((await readdir(join(session, "Default", "Extensions"))).length).toBe(1);

  // This is the reversibility guarantee, and it is the whole reason a clone is acceptable: whatever
  // the agent does, the person's own profile is untouched, locks included.
  expect((await readdir(source)).sort()).toEqual(before.entries);
  expect(await readFile(join(source, "Preferences"), "utf8")).toBe(before.preferences);
  expect((await stat(join(source, "Default", "Cookies"))).size).toBe(before.cookieSize);
  expect((await stat(join(source, "Preferences"))).mtimeMs).toBe(before.modified);

  await result.close();
  await rm(root, { recursive: true, force: true });
});

test("a session holding real logins cannot be created without naming where it may go", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-clone-gate-"));
  const source = await fixtureProfile(root, "google-chrome");
  const session = join(root, "session-profile");
  await mkdir(session, { recursive: true });
  const capabilities = capabilitiesFor(source);

  // Unbounded origins are exactly the case the policy exists to prevent, so this is refused before
  // a single byte is copied.
  await expect(cloneProfile(source, session, freshProfilePolicy, capabilities)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(cloneProfile(source, session, parsePolicy({ allow: ["read"] }), capabilities)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  // Nothing was copied by the refused attempts.
  expect((await readdir(session)).length).toBe(0);

  // A profile no detected install owns has no binary that could decrypt it.
  await expect(cloneProfile(join(root, "nobody"), session, bounded, capabilities)).rejects.toMatchObject({ code: "UNSUPPORTED" });

  await rm(root, { recursive: true, force: true });
});

test("a keyring profile refuses rather than starting a silently signed out browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-clone-keyring-"));
  const profile = join(root, "google-chrome");
  await mkdir(join(profile, "Default"), { recursive: true });
  const database = new Database(join(profile, "Default", "Cookies"));
  database.run("create table cookies (host_key text, name text, encrypted_value blob)");
  database.prepare("insert into cookies values (?, ?, ?)").run("h", "n", Buffer.concat([Buffer.from("v11"), Buffer.from([1])]));
  database.close();
  const session = join(root, "session-profile");
  await mkdir(session, { recursive: true });

  const withoutSecrets = { ...capabilitiesFor(profile), secretService: "absent" as const };
  await expect(cloneProfile(profile, session, bounded, withoutSecrets)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const withoutProxy = { ...capabilitiesFor(profile), filteredBusProxy: null };
  await expect(cloneProfile(profile, session, bounded, withoutProxy)).rejects.toMatchObject({ code: "UNSUPPORTED" });

  await rm(root, { recursive: true, force: true });
});

test("the workspace helper is still what sessions are built under", async () => {
  // Guards the assumption the clone makes about where a session profile lives.
  const root = await createWorkspaceDirectory("clone-test");
  expect(typeof root).toBe("string");
  expect((await stat(root)).isDirectory()).toBe(true);
});

test("the clone is private even when the person's own profile is not", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-clone-mode-"));
  const source = await fixtureProfile(root, "google-chrome");
  // A real browser profile on this workstation is 0755. That is the person's choice for their own
  // directory and not acceptable for a copy of their live logins sitting in a workspace.
  await chmod(source, 0o755);
  const session = join(root, "session-profile");
  await mkdir(session, { recursive: true });

  const result = await cloneProfile(source, session, bounded, capabilitiesFor(source));
  expect((await stat(session)).mode & 0o777).toBe(0o700);
  // The source keeps its own permissions: Orbit tightens its copy, it does not change the person's.
  expect((await stat(source)).mode & 0o777).toBe(0o755);

  await result.close();
  await rm(root, { recursive: true, force: true });
});
