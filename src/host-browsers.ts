import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, posix, win32 } from "node:path";
import { darwinBrowserInstalls, windowsBrowserInstalls } from "./runtime-paths";
import { stateDirectory } from "./service";

/**
 * Which browser on the person's own desktop the viewer opens in, and whether that browser can give it
 * a window of its own rather than a tab.
 *
 * This is not `platform.ts`. That module enumerates the Chrome and Chromium installs a SESSION can be
 * launched with, and cares about profiles and keyring items, because a session browser is a thing Orbit
 * drives. This one enumerates every browser the PERSON can read the viewer in, Firefox forks included,
 * and cares about one capability only: can it be handed a single URL and told to drop the tab strip.
 */

/** A browser installed on the host, as the viewer may open it. */
export type HostBrowser = {
  /** Stable identifier. The desktop entry's file name without .desktop, or the executable's name. */
  id: string;
  /** What to call it in a settings row. */
  name: string;
  /** argv prefix. The URL is appended by `viewerCommand`, never interpolated into a shell string. */
  command: string[];
  /**
   * Can this browser open a URL as its own window, with no tab strip and no address bar? True for the
   * Chromium family, which takes `--app=`. False for the Firefox family: site specific browsers were
   * removed in Firefox 86 and no release build carries a replacement flag, so a Firefox fork opens the
   * viewer as an ordinary tab whatever Orbit asks for.
   */
  appWindow: boolean;
  /** Set on the entry the desktop would have used by itself, so a settings row can say which that is. */
  isDefault: boolean;
};

/**
 * The families, by the token that appears in an executable name. Membership decides app window support
 * and nothing else, so a fork nobody has listed still appears in the picker and still opens the viewer;
 * it just opens it in a tab. Guessing the other way, assuming `--app` works, produces a browser that
 * refuses to start, which is worse than a tab.
 */
const CHROMIUM_TOKENS = ["chrome", "chromium", "msedge", "microsoft-edge", "brave", "vivaldi", "opera", "thorium", "yandex"];
const FIREFOX_TOKENS = ["firefox", "librewolf", "waterfox", "floorp", "zen", "mullvad", "icecat", "seamonkey"];

function family(command: string[], name: string, entry: string) {
  // The command and the entry's own name, and nothing else. A flatpak's executable is `flatpak`, so the
  // branding is in the application id, and a browser launched through a wrapper script has it in neither;
  // the name carries it in both cases. The rest of the entry is deliberately not searched: Zen's MimeType
  // list contains `x-scheme-handler/chrome`, which would file a Firefox fork under Chromium.
  const haystack = `${command.join(" ")} ${name}`.toLowerCase();
  if (CHROMIUM_TOKENS.some(token => haystack.includes(token))) return "chromium";
  if (FIREFOX_TOKENS.some(token => haystack.includes(token))) return "firefox";
  // A fork nobody listed still names itself in the private window action every browser ships, and the
  // two families spell that flag differently. Helium is the case this exists for: a Chromium build whose
  // name carries no Chromium token at all, which would otherwise lose its window and get a tab.
  if (entry.includes("--incognito")) return "chromium";
  if (entry.includes("--private-window")) return "firefox";
  return "unknown";
}

const SYSTEM_FLATPAK = "/var/lib/flatpak/exports/share";

/** Where a desktop entry can live, most specific first, which is also override order. */
function applicationDirectories(env: Record<string, string | undefined>) {
  const home = env.HOME || homedir();
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  const dirs = (env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(Boolean);
  // A broker started by systemd can inherit an XDG_DATA_DIRS that predates flatpak's generator, and a
  // flatpak browser exists nowhere else, so the system exports directory is added when it is missing.
  // A value that is present and empty is a caller asking for exactly the directories it named.
  if (dirs.length && !dirs.includes(SYSTEM_FLATPAK)) dirs.push(SYSTEM_FLATPAK);
  return [data, join(data, "flatpak", "exports", "share"), ...dirs].map(root => join(root, "applications"));
}

/**
 * Split an Exec line the way the desktop entry specification does: spaces separate, quotes group, and
 * the field codes are removed rather than filled in. `%u` and friends are where a URL would go, and the
 * viewer appends its own URL last, so leaving a code in place would hand the browser a literal `%u`.
 *
 * `@@u` and `@@` are flatpak's file forwarding markers. They wrap the arguments flatpak would rewrite
 * into portal paths; with no file arguments left between them they wrap nothing, and flatpak rejects an
 * unterminated pair, so both markers go with the codes they were wrapping.
 */
export function parseExec(line: string): string[] {
  const parts: string[] = [];
  let current = "", quote = "", started = false;
  for (let index = 0; index < line.length; index++) {
    const character = line.charAt(index);
    if (quote) {
      if (character === "\\" && index + 1 < line.length) { current += line[++index]; continue; }
      if (character === quote) { quote = ""; continue; }
      current += character;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (character === " ") { if (started) parts.push(current); current = ""; started = false; }
    else { current += character; started = true; }
  }
  if (started) parts.push(current);
  return parts.filter(part => !/^%[fFuUdDnNickvm]$/.test(part) && part !== "@@" && part !== "@@u" && part !== "@@U");
}

/** The keys of an entry's own `[Desktop Entry]` group. Later groups are actions, which are not browsers. */
function readEntry(text: string) {
  const fields: Record<string, string> = {};
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { if (inside) break; inside = line === "[Desktop Entry]"; continue; }
    if (!inside || !line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    // Localised keys are `Name[ar]`; the unlocalised one is what a settings row shows, so they are skipped.
    if (split > 0 && !line.slice(0, split).includes("[")) fields[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return fields;
}

/** What the desktop would open a link with by itself, as a .desktop file name. */
async function defaultEntry(): Promise<string> {
  try {
    const child = Bun.spawn(["xdg-settings", "get", "default-web-browser"], { stdout: "pipe", stderr: "ignore" });
    const name = (await new Response(child.stdout).text()).trim();
    return await child.exited === 0 ? name : "";
  } catch { return ""; }
}

/**
 * Every browser the person could read the viewer in. Ordered with the desktop's own default first, then
 * by name, because the first entry is what an unset setting resolves to.
 *
 * A browser is anything that claims `x-scheme-handler/http`, which is the same question the desktop asks
 * when it opens a link. A hardcoded list of binary paths was the alternative and it misses every flatpak,
 * which on this machine is the default browser.
 */
/**
 * The browsers a Mac can open the viewer in, as bundles rather than desktop entries.
 *
 * Built from the same `darwinBrowserInstalls()` the session launcher uses, so the viewer and a
 * session agree about what is installed and where. The command is the Mach-O INSIDE the bundle,
 * never `open`, for the reason the launcher documents: `open` activates the person's running
 * browser and hands it the URL.
 *
 * `appWindow: true` for all of them, because every entry here is Chromium family and therefore
 * takes `--user-data-dir`. That is what earns the viewer a profile of its own, which is the whole
 * point of listing them.
 *
 * Deliberately NOT a LaunchServices query. `mdfind` and `lsregister` would find more browsers, and
 * both are slower, undocumented or both, and neither is needed: the viewer needs one browser that
 * accepts a private profile, not an inventory.
 */
function darwinHostBrowsers(): HostBrowser[] {
  return darwinBrowserInstalls().map(install => ({
    id: install.id,
    name: install.bundle.split("/").pop()?.replace(/\.app$/, "") ?? install.id,
    command: [install.executable],
    appWindow: true,
    // No notion of a default here: LaunchServices knows which browser owns http, and asking it means
    // `lsregister` or a Launch Services API this project does not link. The first install wins, which
    // is the Chrome first order `darwinBrowserInstalls` already documents.
    isDefault: false,
  }));
}

/**
 * The Windows browsers the viewer can have a private window in.
 *
 * Same shape and same reason as `darwinHostBrowsers`: Windows has no `.desktop` files either, so every
 * scan below found nothing, `pickBrowser` returned undefined, and the viewer fell through to
 * `fallbackCommand`, which on win32 is `cmd /c start`. That hands the URL to the shell's default
 * browser association, in the profile the person is logged into, and the viewer URL carries the bearer
 * token that can observe, drive and stop sessions. The token then lives in that profile's history and
 * session restore. It happened on EVERY Windows machine rather than in a corner case, exactly as it
 * did on every Mac, and the macOS fix was simply never extended here.
 *
 * `windowsBrowserInstalls` already finds Chrome, Chromium and Edge and is the same list the session
 * launcher uses, so this reuses it rather than probing again. Only `.executable` is taken: the
 * `profileDirectory` field it also carries is the PERSON's profile, and handing that to the viewer is
 * the failure being fixed, not the fix.
 */
function windowsHostBrowsers(env: Record<string, string | undefined> = process.env): HostBrowser[] {
  return windowsBrowserInstalls(env as NodeJS.ProcessEnv).map(install => ({
    id: install.id,
    name: basename(install.executable).replace(/\.exe$/i, ""),
    command: [install.executable],
    appWindow: true,
    // No notion of a default: the shell association is what `cmd /c start` would have used, and using
    // it is the defect. The first install wins, which is the Chrome first order the prober documents.
    isDefault: false,
  }));
}

export async function listHostBrowsers(env: Record<string, string | undefined> = process.env): Promise<HostBrowser[]> {
  // macOS has no `.desktop` files, so every scan below finds nothing and every viewer open fell
  // through to `fallbackCommand`, which is `open`: LaunchServices hands the URL to the person's
  // already running browser, in their real profile. That is the viewer's access token landing in the
  // browser this project exists to leave alone, and it happened on EVERY Mac rather than in a corner
  // case. The bundles are listed here instead, so `openViewer` can give the viewer a profile of its
  // own exactly as it does on Linux.
  if (process.platform === "darwin") return darwinHostBrowsers();
  // Windows has none either, for the same reason and with the same consequence.
  if (process.platform === "win32") return windowsHostBrowsers(env);
  const preferred = await defaultEntry();
  const found = new Map<string, HostBrowser>();
  for (const directory of applicationDirectories(env)) {
    let names: string[];
    try { names = await readdir(directory); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".desktop") || found.has(name)) continue;
      let text: string, fields: Record<string, string>;
      try { text = await readFile(join(directory, name), "utf8"); } catch { continue; }
      fields = readEntry(text);
      if (fields.Type !== "Application" || !fields.Exec) continue;
      if (fields.NoDisplay === "true" || fields.Hidden === "true") continue;
      if (!(fields.MimeType || "").split(";").includes("x-scheme-handler/http")) continue;
      // Handling http is not enough on its own. A desktop application that registers the scheme so it can
      // catch its own sign-in links, which is what the ChatGPT launcher on this machine does, would
      // otherwise be offered as somewhere to read the viewer. The category is the entry saying it is a
      // browser rather than merely reachable by a link.
      if (!(fields.Categories || "").split(";").includes("WebBrowser")) continue;
      const command = parseExec(fields.Exec);
      const [executable] = command;
      if (!executable) continue;
      found.set(name, {
        id: name.replace(/\.desktop$/, ""), name: fields.Name || basename(executable),
        command, appWindow: family(command, fields.Name || name, text) === "chromium", isDefault: name === preferred,
      });
    }
  }
  return [...found.values()].sort((left, right) =>
    Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
}

/**
 * The argv that opens `url`, in its own window where the browser has one.
 *
 * `--app=` is the whole of the app window story for the Chromium family: no manifest, no install and no
 * fixed port, which matters because the viewer's port is allocated per broker and its access token lives
 * in the fragment. An installed progressive web app is scoped to an origin, port included, and would be
 * launched at `/` with no token, so it is a larger change than the window the person actually asked for.
 */
export function viewerCommand(browser: HostBrowser, url: string, appWindow = true, profile?: string): string[] {
  const own = profile ? ownProfileArguments(browser, profile) : [];
  return browser.appWindow && appWindow ? [...browser.command, ...own, `--app=${url}`] : [...browser.command, ...own, url];
}

/**
 * Where the viewer's own browser state lives: a profile that is Orbit's, never the person's. Without
 * this the viewer opened inside the person's browser, with their extensions, cookies, history and
 * sign-ins around it, and a viewer window in a browser the person is also using is a tab strip away
 * from becoming a tab. One directory per browser id, because a profile is only readable by the build
 * that wrote it, under the state directory, since it is worth keeping between runs: window size, zoom
 * and the like, and nothing else, because the viewer keeps no state of its own in it.
 */
export function viewerProfileDirectory(browser: Pick<HostBrowser, "id">, env: Record<string, string | undefined> = process.env,
  platform = process.platform): string {
  // Through `stateDirectory`, which is the module that already answers "where does this platform keep
  // a per user application's own records": `%LOCALAPPDATA%\sbar-orbit` on Windows, `~/Library/
  // Application Support` on macOS, `$XDG_STATE_HOME` on Linux. Built here it was `~/.local/state`
  // unconditionally, so on Windows the viewer's profile went to a POSIX path under the home directory,
  // which is neither where Windows keeps such a thing nor covered by the ACL reasoning that protects
  // the rest of Orbit's state.
  // `posix.join` for the POSIX platforms, because `join` is bound to the HOST: with `platform`
  // injectable, a Windows host asking for the Linux or macOS answer got backslashes inside a path that
  // is only ever used there. `stateDirectory` already makes this distinction internally, and building
  // on top of it with the host's separator threw that away. The rule this port keeps relearning: the
  // moment a function takes `platform`, every path it builds for another platform needs that
  // platform's own join.
  const leaf = ["viewer", browser.id.replace(/[^A-Za-z0-9._-]/g, "_")];
  const root = stateDirectory(env as NodeJS.ProcessEnv, platform);
  return platform === "win32" ? win32.join(root, ...leaf) : posix.join(root, ...leaf);
}

/**
 * The flags that keep the viewer in its own profile. The Chromium family takes `--user-data-dir`, and
 * a second invocation with the same directory is forwarded to the instance already running on it, so
 * the viewer keeps one browser process rather than one per click, and the person's own browser, on
 * its own directory, is not that instance. `--class` names the window for the compositor, so it is
 * grouped, matched and remembered as Orbit's viewer rather than as another browser window. The two
 * first-run flags stop a fresh profile greeting the person with a welcome tour and a default browser
 * question, neither of which the viewer is.
 *
 * The Firefox family takes `--profile`, and remoting there is keyed by the profile since Firefox 67,
 * so `--new-window` lands in the instance on this directory and not in the person's. Not measured:
 * no Firefox build is installed on the development host. A family nothing recognised gets no flags,
 * because a flag a browser does not know is a browser that exits, and the fallback caller sees that.
 */
function browserFamily(browser: HostBrowser): "chromium" | "firefox" | "unknown" {
  if (browser.appWindow) return "chromium";
  return FIREFOX_TOKENS.some(token => `${browser.command.join(" ")} ${browser.name}`.toLowerCase().includes(token))
    ? "firefox" : "unknown";
}

/**
 * Whether this browser can be handed a profile that is Orbit's rather than the person's.
 *
 * The Chromium family takes `--user-data-dir` and the Firefox family takes `--profile`. A family
 * nothing recognises gets no flags at all, which means opening the viewer in it opens the viewer in
 * whatever profile that browser is already running: the person's cookies, history and sign-ins around
 * a page holding a token that can observe and drive agent sessions.
 *
 * So this is the question `pickBrowser` has to ask first. It used to ask "can it give a window", which
 * is a different question with a different answer, and the gap between them is how the viewer ended up
 * in the person's own browser.
 */
export function canTakeOwnProfile(browser: HostBrowser): boolean {
  return browserFamily(browser) !== "unknown";
}

function ownProfileArguments(browser: HostBrowser, profile: string): string[] {
  const family = browserFamily(browser);
  if (family === "chromium") return [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--class=sbar-orbit-viewer"];
  if (family === "firefox") return ["--profile", profile, "--new-window"];
  return [];
}

/** The last resort: whatever the platform opens a link with, when no entry was found or the choice is gone. */
function fallbackCommand(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

/**
 * Which browser an unset choice resolves to. The desktop's own default comes first and keeps that place
 * whenever it can give the viewer a window; a default that cannot, which on a Firefox fork is every one
 * of them, steps aside for the first installed browser that can, because a window of its own is the
 * thing being asked for. With app windows turned off the desktop's default wins outright.
 */
export function pickBrowser(browsers: HostBrowser[], choice = "", appWindow = true): HostBrowser | undefined {
  const chosen = browsers.find(entry => entry.id === choice);
  if (chosen) return chosen;
  // A browser that can be given a private profile comes FIRST, always, and the desktop's default only
  // wins when it is one of those. It used to win outright whenever `appWindow` was off, and on a
  // desktop whose default is a Firefox fork that handed the viewer to the browser the person lives in.
  // Measured here: the default is Zen, so `appWindow: false` picked Zen while Chrome, Chromium, Helium
  // and Edge were all installed and all able to take `--user-data-dir`.
  //
  // A window of its own and a profile of its own are different promises. Turning off the first must
  // not silently give up the second: `viewerCommand` still opens a plain tab when `appWindow` is off,
  // but it opens it in Orbit's OWN profile, with none of the person's cookies, history or sign-ins.
  const isolatable = browsers.filter(entry => canTakeOwnProfile(entry));
  if (isolatable.length === 0) return browsers[0];
  // The default keeps its place only when it can ALSO give the viewer a window of its own, or when the
  // caller turned windows off deliberately AND the default is not the browser the person lives in.
  //
  // A Firefox fork takes `--profile`, so it is isolatable, but remoting there is keyed by profile and
  // the result is still a window of the browser the person has open, in their taskbar, in their
  // window list, looking like their browser. That is the confusion being removed. A Chromium browser
  // with `--class=sbar-orbit-viewer` and its own user-data-dir is unmistakably Orbit's, so when one is
  // installed it is preferred over a Firefox-family default whatever `appWindow` says.
  const chromiumCapable = isolatable.filter(entry => entry.appWindow);
  const preferred = isolatable[0]?.isDefault ? isolatable[0] : undefined;
  if (preferred && (preferred.appWindow || chromiumCapable.length === 0)) return preferred;
  const pool = chromiumCapable.length > 0 ? chromiumCapable : isolatable;
  return [...pool].sort((left, right) => rank(left) - rank(right))[0] ?? browsers[0];
}

/**
 * The order to fall back through, which is the order `platform.ts` already establishes for the browsers
 * Orbit launches sessions with. Alphabetical was the alternative and it is not a preference: it put
 * Chromium ahead of Chrome for no reason other than the letter it starts with.
 */
const PREFERRED = ["google-chrome", "chromium", "microsoft-edge", "brave", "vivaldi"];
const rank = (browser: HostBrowser) => {
  const haystack = `${browser.id} ${browser.command.join(" ")}`.toLowerCase();
  const found = PREFERRED.findIndex(token => haystack.includes(token));
  return found < 0 ? PREFERRED.length : found;
};

/** How the viewer was opened, so a caller can say so rather than claim a window it did not get. */
export type ViewerOpen = { opened: boolean; browser: string; appWindow: boolean };

/**
 * Open the viewer. `choice` is a browser id from `listHostBrowsers`; an id that is no longer installed
 * falls through to the default browser rather than failing, because a person whose browser was removed
 * still wants to see their agent.
 */
export async function openViewer(url: string, choice = "", appWindow = true,
  env: Record<string, string | undefined> = process.env): Promise<ViewerOpen> {
  const browsers = await listHostBrowsers(env);
  const browser = pickBrowser(browsers, choice, appWindow);
  const failure = { opened: false, browser: browser?.id ?? "", appWindow: false };
  // The fallback opens the URL with whatever the platform hands links to, which means the person's
  // own browser in their own profile. On Linux the viewer's token going there is a deliberate last
  // resort for a machine with no recognised browser, because `xdg-open` may well reach a browser that
  // takes no private profile and the person chose that association themselves.
  //
  // macOS and Windows are refused instead. `open` does not merely use their profile: LaunchServices
  // activates the browser they are already using and hands it the command line. `cmd /c start` hands
  // the URL to the shell association, in the profile they are logged into. Both put a token that can
  // observe, drive and stop sessions into the browser this project promises never to touch, and both
  // now enumerate their own installs above, so reaching the fallback means the machine genuinely has
  // no Chromium family browser. Such a machine gets no viewer rather than a viewer in their window.
  if (!browser && process.platform !== "linux") return failure;
  let profile: string | undefined;
  if (browser) {
    // A browser reached here that cannot take its own profile is the last-resort case, not a normal
    // one: `pickBrowser` prefers every isolatable browser over the default, so this only happens when
    // nothing installed takes `--user-data-dir` or `--profile`. Opening the viewer in it would put the
    // session token in the person's own profile, which is the thing this project exists to prevent, so
    // it is refused everywhere rather than only off Linux.
    if (!canTakeOwnProfile(browser)) return failure;
    profile = viewerProfileDirectory(browser, env);
    // A directory the browser cannot create is a browser that exits with a profile error, so it is
    // made here, private, and a failure to make it is reported as the viewer not opening.
    try { await mkdir(profile, { recursive: true, mode: 0o700 }); } catch { return failure; }
  }
  const command = browser ? viewerCommand(browser, url, appWindow, profile) : fallbackCommand(url);
  let child;
  try {
    // Streams discarded: a pipe nobody reads is a browser that blocks once it has printed enough to
    // fill it.
    child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch { return failure; }
  /*
   * Spawning is not opening. A binary that is missing or not executable throws above, but a browser
   * that starts, rejects its arguments and exits does not, and reporting that as opened is what leaves
   * a caller with no window and no fallback. So the exit code is given a moment to arrive.
   *
   * Exiting at once with zero is not a failure: it is the ordinary case for a second invocation, whose
   * command line is forwarded to the instance already running, and that instance is what opens the
   * window. Observed on this machine: the forwarded invocation exits immediately and a second app
   * window appears.
   */
  const rejected = await Promise.race([
    child.exited.then(code => code !== 0),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 700)),
  ]);
  // Unreferenced either way: the browser outlives the broker's reply to this call.
  child.unref();
  if (rejected) return failure;
  return { opened: true, browser: browser?.id ?? "", appWindow: !!browser?.appWindow && appWindow };
}

/**
 * The person's choice, read from the panel's settings file. The settings schema is Python, because the
 * settings window is, and this reads the two values it writes rather than keeping a second schema: a
 * missing file, a missing key or a malformed one all mean the defaults, which is the desktop's own
 * browser in a window of its own.
 */
export async function viewerPreference(env: Record<string, string | undefined> = process.env) {
  const home = env.HOME || homedir();
  const path = join(env.XDG_CONFIG_HOME || join(home, ".config"), "sbar-orbit", "panel.json");
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return { browser: typeof stored.viewerBrowser === "string" ? stored.viewerBrowser : "",
      appWindow: stored.viewerAppWindow !== false };
  } catch { return { browser: "", appWindow: true }; }
}
