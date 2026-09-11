import { Database } from "bun:sqlite";
import { access, constants, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What this machine can actually do, probed rather than assumed.
 *
 * Orbit was written for one Fedora workstation and hardcodes that everywhere. Porting to other
 * desktops, other distributions, Windows and macOS starts here: every platform specific decision
 * becomes a probe with a recorded answer, so an unsupported combination is refused with a reason
 * instead of silently producing a browser that is signed out or a copy that fills the disk.
 *
 * Nothing here starts an application, decrypts anything, or reads a cookie name, host or value.
 */

/** The concrete backend a browser is launched with. */
export type PasswordStore = "basic" | "gnome-libsecret" | "kwallet";

/**
 * What the bytes on disk tell us, which is less than the backend name.
 *
 * Chromium writes a v10 prefix for the hardcoded key and a v11 prefix for a key held by a secret
 * service, but both gnome-libsecret and kwallet write v11, so the file cannot say which one. The
 * scheme comes from the profile and the backend comes from the desktop, and conflating the two would
 * hand a KDE profile to gnome-libsecret and decrypt nothing.
 */
export type CookieScheme = "basic" | "keyring";

/** How a browser is packaged, because it decides where the profile lives and who can reach it. */
export type BrowserPackaging = "system" | "flatpak" | "snap" | "home";

export type BrowserInstall = {
  /** Stable identifier, for example google-chrome or chromium. */
  id: string;
  executable: string;
  packaging: BrowserPackaging;
  /** The user data directory this install owns, whether or not it exists yet. */
  profileDirectory: string;
  /**
   * The keyring item Chromium looks up is named after the branding of the binary, so Chrome cannot
   * read a profile Chromium wrote and the reverse is also true. Measured on this workstation: a
   * cross binary clone returns every cookie undecryptable.
   */
  keyringItem: string;
  /**
   * The value of the `application` attribute Chromium stores its key under, which is what a lookup
   * matches on. Chrome writes "chrome" and Chromium writes "chromium", which is the same split that
   * makes a cross binary clone decrypt nothing.
   */
  keyringApplication: string;
};

export type SecretServiceState = "available" | "absent" | "unknown";

export type PlatformCapabilities = {
  platform: NodeJS.Platform;
  /** wayland, x11 or none. A headless host reports none and can still run the browser backend. */
  sessionType: "wayland" | "x11" | "none";
  desktop: string;
  /** The private display backend is Linux only and needs a compositor it can nest. */
  nativeDisplaySupported: boolean;
  /** The browser backend needs no display at all, which is why it ports first. */
  browserBackendSupported: boolean;
  secretService: SecretServiceState;
  /** A filtering bus proxy is how a browser reaches the keyring without the whole session bus. */
  filteredBusProxy: string | null;
  /** systemd user scopes carry Orbit's resource budget. Without them there is no budget to enforce. */
  systemdUserScopes: boolean;
  browsers: BrowserInstall[];
  notes: string[];
};

const exists = async (path: string, executable = false) => {
  try { await access(path, executable ? constants.X_OK : constants.R_OK); return true; } catch { return false; }
};

/**
 * Candidate browser installs. The order is not a preference: every install is reported, because the
 * only correct choice for a given profile is the install that owns it.
 */
function browserCandidates(home: string): Omit<BrowserInstall, "executable">[] {
  const chrome = { id: "google-chrome", keyringItem: "Chrome Safe Storage", keyringApplication: "chrome" };
  const chromium = { id: "chromium", keyringItem: "Chromium Safe Storage", keyringApplication: "chromium" };
  return [
    { ...chrome, packaging: "system", profileDirectory: join(home, ".config", "google-chrome") },
    { ...chromium, packaging: "system", profileDirectory: join(home, ".config", "chromium") },
    // A Flatpak browser keeps its profile inside its own application directory. It asked the Secret
    // portal rather than the session bus, but the portal proxies to the same login keyring item, so
    // a directly launchable browser of the same branding still decrypts it.
    { ...chrome, packaging: "flatpak", profileDirectory: join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome") },
    { ...chromium, packaging: "flatpak", profileDirectory: join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium") },
    { ...chromium, packaging: "snap", profileDirectory: join(home, "snap", "chromium", "current", ".config", "chromium") },
  ];
}

const executablesFor: Record<string, string[]> = {
  "google-chrome": ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
  chromium: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/lib64/chromium-browser/chromium-browser"],
};

/** Installs whose executable is present. A profile directory that does not exist yet is still reported. */
export async function detectBrowsers(home = homedir()): Promise<BrowserInstall[]> {
  const found: BrowserInstall[] = [];
  for (const candidate of browserCandidates(home)) {
    if (candidate.packaging === "flatpak" || candidate.packaging === "snap") {
      // A sandboxed browser is launched through its own runner, not through a path Orbit can exec.
      const runner = candidate.packaging === "flatpak" ? "/usr/bin/flatpak" : "/usr/bin/snap";
      if (!await exists(runner, true) || !await exists(candidate.profileDirectory)) continue;
      found.push({ ...candidate, executable: runner });
      continue;
    }
    for (const executable of executablesFor[candidate.id] ?? []) {
      if (!await exists(executable, true)) continue;
      found.push({ ...candidate, executable });
      break;
    }
  }
  return found;
}

/**
 * Which key encrypted the cookies already in this profile, read from the three byte version prefix
 * that Chromium writes in front of every encrypted value. Reads no name, host, path or value.
 *
 * v10 is the hardcoded key that any program running as this user can reproduce. v11 means the key is
 * in the login keyring, so the browser needs a secret service to decrypt at all.
 */
export async function profileCookieScheme(profileDirectory: string): Promise<{ scheme: CookieScheme; rows: number } | null> {
  const jar = join(profileDirectory, "Default", "Cookies");
  if (!await exists(jar)) return null;
  try {
    const database = new Database(jar, { readonly: true });
    const rows = database.query("select hex(substr(encrypted_value,1,3)) prefix, count(*) n from cookies group by 1").all() as { prefix: string; n: number }[];
    database.close();
    let total = 0, keyring = 0;
    for (const row of rows) {
      total += row.n;
      if (Buffer.from(row.prefix, "hex").toString() === "v11") keyring += row.n;
    }
    return { scheme: keyring > 0 ? "keyring" : "basic", rows: total };
  } catch { return null; }
}

/**
 * The store a browser must be launched with to read the profile it is being given.
 *
 * A keyring profile needs the backend this desktop actually runs. KDE keeps its key in kwallet and
 * everything else that answers org.freedesktop.secrets is reached through libsecret, so the desktop
 * decides. With no secret service the basic store is the honest answer, because asking for a keyring
 * that is not there leaves the browser unable to decrypt and unable to say why.
 */
export function passwordStoreFor(scheme: CookieScheme, secretService: SecretServiceState, desktop = ""): PasswordStore {
  if (scheme === "basic") return "basic";
  if (secretService !== "available") return "basic";
  return /\bKDE\b|plasma/i.test(desktop) ? "kwallet" : "gnome-libsecret";
}

async function secretServiceState(): Promise<SecretServiceState> {
  if (process.platform !== "linux" || !process.env.DBUS_SESSION_BUS_ADDRESS) return "absent";
  if (!await exists("/usr/bin/busctl", true)) return "unknown";
  const probe = Bun.spawn(["/usr/bin/busctl", "--user", "--list", "--no-legend", "--no-pager"], { stdout: "pipe", stderr: "ignore" });
  if (await probe.exited !== 0) return "unknown";
  return (await new Response(probe.stdout).text()).includes("org.freedesktop.secrets") ? "available" : "absent";
}

async function systemdUserScopes(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  for (const tool of ["/usr/bin/systemctl", "/usr/bin/systemd-run"]) if (!await exists(tool, true)) return false;
  const probe = Bun.spawn(["/usr/bin/systemctl", "--user", "is-system-running"], { stdout: "ignore", stderr: "ignore" });
  await probe.exited;
  // running or degraded both mean a usable user manager; only a missing manager is fatal here.
  return probe.exitCode === 0 || probe.exitCode === 1;
}

/**
 * Does this directory's filesystem share extents on copy? A 5.3 GiB browser profile is free to clone
 * on btrfs or xfs and a real multi gigabyte copy on ext4, which is the difference between a feature
 * and a disk filling surprise. Probed by actually asking for a reflink, because the filesystem name
 * is not enough: xfs only reflinks when it was made with reflink=1.
 */
export async function supportsReflink(directory: string): Promise<boolean> {
  let work: string | undefined;
  try {
    work = await mkdtemp(join(directory, ".orbit-reflink-"));
    const source = join(work, "a");
    await writeFile(source, "orbit reflink probe");
    const probe = Bun.spawn(["/usr/bin/cp", "--reflink=always", source, join(work, "b")], { stdout: "ignore", stderr: "ignore" });
    return await probe.exited === 0;
  } catch { return false; }
  finally { if (work) await rm(work, { recursive: true, force: true }); }
}

/** Everything the broker needs to know before it offers a backend or a real session feature. */
export async function detectPlatform(home = homedir()): Promise<PlatformCapabilities> {
  const platform = process.platform;
  const linux = platform === "linux";
  const sessionType = !linux ? "none"
    : process.env.WAYLAND_DISPLAY ? "wayland"
    : process.env.DISPLAY ? "x11" : "none";
  const secretService = await secretServiceState();
  const notes: string[] = [];
  if (!linux) notes.push("Only the browser backend is designed for this platform, and it is unverified. See docs/porting.md.");
  if (linux && sessionType === "none") notes.push("No desktop session was found. The browser backend needs none; the private display does.");
  if (secretService === "absent") notes.push("No secret service answered, so a profile whose cookies need the keyring cannot be decrypted here.");
  return {
    platform, sessionType, desktop: process.env.XDG_CURRENT_DESKTOP ?? "",
    // The private display nests its own compositor, so it depends on Linux and on the bundled
    // runtime rather than on which desktop the person happens to be using.
    nativeDisplaySupported: linux,
    browserBackendSupported: linux,
    secretService,
    filteredBusProxy: linux && await exists("/usr/bin/xdg-dbus-proxy", true) ? "/usr/bin/xdg-dbus-proxy" : null,
    systemdUserScopes: await systemdUserScopes(),
    browsers: linux ? await detectBrowsers(home) : [],
    notes,
  };
}

/**
 * The capability report, safe to paste into a public issue.
 *
 * Orbit reads browser profiles and reaches a keyring, so a careless diagnostic in this project is a
 * credential leak. Nothing here carries a cookie name, host or value, an account name, a viewer token
 * or a path that names the person: the home directory is collapsed to a tilde, and a profile is
 * reported as present or absent with a row count, never by its contents.
 */
export async function describeMachine(home = homedir()): Promise<Record<string, unknown>> {
  const capabilities = await detectPlatform(home);
  const redact = (path: string) => path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const browsers = await Promise.all(capabilities.browsers.map(async install => {
    const scheme = await profileCookieScheme(install.profileDirectory);
    return {
      id: install.id, packaging: install.packaging, executable: install.executable,
      profileDirectory: redact(install.profileDirectory),
      // The store and the row count are the two facts that decide whether a clone can work. Neither
      // identifies a site the person visited.
      cookieScheme: scheme?.scheme ?? "none", cookieRows: scheme?.rows ?? 0,
    };
  }));
  return {
    report: "orbit-capabilities",
    platform: capabilities.platform, sessionType: capabilities.sessionType, desktop: capabilities.desktop,
    browserBackendSupported: capabilities.browserBackendSupported,
    nativeDisplaySupported: capabilities.nativeDisplaySupported,
    secretService: capabilities.secretService,
    filteredBusProxy: Boolean(capabilities.filteredBusProxy),
    systemdUserScopes: capabilities.systemdUserScopes,
    browsers, notes: capabilities.notes,
    redacted: ["home directory collapsed to ~", "no cookie names, hosts or values", "no account names", "no viewer tokens"],
  };
}

export type CloneRefusal = { allowed: false; reason: string } | { allowed: true; install: BrowserInstall; store: PasswordStore; reflink: boolean };

/**
 * May Orbit clone this profile? Every no here is a measured failure mode, not caution: a cross binary
 * clone decrypts nothing, a keyring profile with no secret service decrypts nothing, a sandboxed
 * browser's key is behind a portal, and a copy on a filesystem without reflink is a real multi
 * gigabyte copy. Refusing with a reason is the whole point of this function.
 */
export async function canCloneProfile(profileDirectory: string, capabilities: PlatformCapabilities, workspace: string): Promise<CloneRefusal> {
  const install = capabilities.browsers.find(candidate => candidate.profileDirectory === profileDirectory);
  if (!install) return { allowed: false, reason: "No detected browser install owns that profile directory, so the binary that can decrypt it is unknown." };
  // Packaging decides where a profile lives, not whether its key can be read: the keyring item is
  // keyed by the application attribute, not by the sandbox, so a directly launchable browser of the
  // same branding opens a profile a sandboxed one wrote. Measured here on a Flatpak Chrome profile,
  // 115 of 115 cookies decrypted under the system Chrome binary. That tree was a LEFTOVER from an
  // uninstalled application, so it is evidence that the keyring item is shared, not proof that a live
  // Flatpak browser behaves the same way. docs/porting.md carries the difference as an open gate.
  //
  // Orbit must never launch the sandboxed browser itself. flatpak run places it in its own transient
  // scope under app.slice, outside the cgroup that carries Orbit's budget, which trips
  // RESOURCE_BOUNDARY_LOST. A launchable install is handed the profile instead.
  const launcher = capabilities.browsers.find(candidate =>
    candidate.id === install.id && (candidate.packaging === "system" || candidate.packaging === "home"));
  if (!launcher)
    return { allowed: false, reason: `That profile was written by ${install.id}, and no directly launchable ${install.id} is installed. A browser of another branding looks up a differently named keyring item and would decrypt nothing.` };
  const scheme = await profileCookieScheme(profileDirectory);
  if (!scheme) return { allowed: false, reason: "That profile has no readable cookie store, so there is no session to inherit." };
  if (scheme.scheme === "keyring" && capabilities.secretService !== "available")
    return { allowed: false, reason: "That profile's cookies need the login keyring and no secret service answered, so the clone would start signed out." };
  if (scheme.scheme === "keyring" && !capabilities.filteredBusProxy)
    return { allowed: false, reason: "Reaching the keyring safely needs xdg-dbus-proxy, which is not installed. Orbit will not hand a browser the whole session bus instead." };
  return { allowed: true, install: launcher, store: passwordStoreFor(scheme.scheme, capabilities.secretService, capabilities.desktop), reflink: await supportsReflink(workspace) };
}

/** The three markers a copied profile inherits from a running browser. Chrome refuses to start while
 * they are present, and has been observed asking a desktop dialog to resolve it, which would put a
 * window on the person's screen. They are deleted from the copy, never from the source. */
export const singletonMarkers = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

export async function stripSingletonMarkers(profileCopy: string): Promise<string[]> {
  const removed: string[] = [];
  for (const marker of singletonMarkers) {
    const path = join(profileCopy, marker);
    try { await stat(path); } catch { continue }
    await rm(path, { force: true });
    removed.push(marker);
  }
  return removed;
}
