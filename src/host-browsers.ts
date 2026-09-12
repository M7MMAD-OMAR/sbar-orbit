import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";

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
    const character = line[index]!;
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
export async function listHostBrowsers(env: Record<string, string | undefined> = process.env): Promise<HostBrowser[]> {
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
      if (!command.length) continue;
      found.set(name, {
        id: name.replace(/\.desktop$/, ""), name: fields.Name || basename(command[0]!),
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
export function viewerCommand(browser: HostBrowser, url: string, appWindow = true): string[] {
  return browser.appWindow && appWindow ? [...browser.command, `--app=${url}`] : [...browser.command, url];
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
  if (chosen || !appWindow) return chosen ?? browsers[0];
  if (browsers[0]?.appWindow) return browsers[0];
  const capable = browsers.filter(entry => entry.appWindow);
  return [...capable].sort((left, right) => rank(left) - rank(right))[0] ?? browsers[0];
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
  const command = browser ? viewerCommand(browser, url, appWindow) : fallbackCommand(url);
  const failure = { opened: false, browser: browser?.id ?? "", appWindow: false };
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
