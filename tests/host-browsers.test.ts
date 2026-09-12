import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHostBrowsers, parseExec, viewerCommand, viewerPreference } from "../src/host-browsers";

/**
 * Detection reads desktop entries, so it is exercised against real ones written to a temporary tree.
 * The entries below are the shapes this machine actually carries: a flatpak with file forwarding, a
 * system Chromium, an Edge installed progressive web app, and a launcher that is not a browser at all.
 */
async function fixture(entries: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "orbit-browsers-"));
  const applications = join(root, "applications");
  await mkdir(applications, { recursive: true });
  for (const [name, text] of Object.entries(entries)) await writeFile(join(applications, name), text);
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

const environment = (root: string) => ({ HOME: root, XDG_DATA_HOME: root, XDG_DATA_DIRS: "" });

test("browsers are the entries that handle http, with app window support decided by family", async () => {
  const tree = await fixture({
    "app.zen_browser.zen.desktop": "[Desktop Entry]\nName=Zen Browser\nType=Application\nExec=/usr/bin/flatpak run --branch=stable --command=launch-script.sh --file-forwarding app.zen_browser.zen @@u %u @@\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\nCategories=Network;WebBrowser;\n",
    "chromium-browser.desktop": "[Desktop Entry]\nName=Chromium\nType=Application\nExec=/usr/bin/chromium-browser %U\nMimeType=text/html;x-scheme-handler/http;\nCategories=Network;WebBrowser;\n",
    "org.gnome.Zenity.desktop": "[Desktop Entry]\nName=Zenity\nType=Application\nExec=/usr/bin/zenity\n",
    "chatgpt.desktop": "[Desktop Entry]\nName=ChatGPT\nType=Application\nExec=chatgpt %U\nCategories=Utility;Development;\nMimeType=x-scheme-handler/codex;x-scheme-handler/http;\n",
    "helium.desktop": "[Desktop Entry]\nName=Helium\nType=Application\nExec=helium %U\nCategories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;\n[Desktop Action new-private-window]\nName=New Incognito Window\nExec=helium --incognito\n",
    "msedge-teams.desktop": "[Desktop Entry]\nName=Microsoft Teams (PWA)\nType=Application\nExec=/opt/microsoft/msedge/microsoft-edge --app-id=abc %U\nMimeType=x-scheme-handler/microsoft-edge;\n",
    "hidden-browser.desktop": "[Desktop Entry]\nName=Hidden\nType=Application\nNoDisplay=true\nExec=/usr/bin/hidden %U\nMimeType=x-scheme-handler/http;\nCategories=Network;WebBrowser;\n",
  });
  const browsers = await listHostBrowsers(environment(tree.root));
  expect(browsers.map(entry => entry.id).sort()).toEqual(["app.zen_browser.zen", "chromium-browser", "helium"]);
  // Helium carries no Chromium token in its name; its private window action is what identifies the family.
  expect(browsers.find(entry => entry.id === "helium")!.appWindow).toBe(true);
  // A progressive web app entry handles its own scheme, not http; the ChatGPT launcher handles http but
  // is not a browser; neither is a dialog tool, nor an entry the desktop itself hides.
  const zen = browsers.find(entry => entry.id === "app.zen_browser.zen")!;
  expect(zen.appWindow).toBe(false);
  expect(zen.command).not.toContain("@@u");
  expect(zen.command).not.toContain("%u");
  expect(browsers.find(entry => entry.id === "chromium-browser")!.appWindow).toBe(true);
  await tree.close();
});

test("a localised name does not replace the plain one, and later directories do not shadow earlier ones", async () => {
  const tree = await fixture({
    "one.desktop": "[Desktop Entry]\nName=One\nName[ar]=واحد\nType=Application\nExec=/usr/bin/chromium %U\nMimeType=x-scheme-handler/http;\nCategories=Network;WebBrowser;\n[Desktop Action new]\nName=Other\nExec=/usr/bin/other\n",
  });
  const [browser] = await listHostBrowsers(environment(tree.root));
  expect(browser!.name).toBe("One");
  // The action group carries its own Exec; reading past the first group would launch the wrong command.
  expect(browser!.command).toEqual(["/usr/bin/chromium"]);
  await tree.close();
});

test("field codes and quoting survive the trip into an argv", () => {
  expect(parseExec('/opt/msedge "--profile-directory=Profile 2" --app-id=x %U'))
    .toEqual(["/opt/msedge", "--profile-directory=Profile 2", "--app-id=x"]);
  expect(parseExec("flatpak run --file-forwarding com.brave.Browser @@u %u @@"))
    .toEqual(["flatpak", "run", "--file-forwarding", "com.brave.Browser"]);
});

test("a Chromium browser gets a window of its own and a Firefox fork gets a tab", () => {
  const chromium = { id: "c", name: "Chromium", command: ["/usr/bin/chromium"], appWindow: true, isDefault: false };
  const zen = { id: "z", name: "Zen", command: ["/usr/bin/zen"], appWindow: false, isDefault: true };
  const url = "http://127.0.0.1:1234/#token";
  expect(viewerCommand(chromium, url)).toEqual(["/usr/bin/chromium", `--app=${url}`]);
  expect(viewerCommand(chromium, url, false)).toEqual(["/usr/bin/chromium", url]);
  // No flag is invented for a browser that has none: the viewer opens as a tab rather than not at all.
  expect(viewerCommand(zen, url)).toEqual(["/usr/bin/zen", url]);
});

test("the stored choice is read from the panel's settings, and its absence is the default", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-preference-"));
  expect(await viewerPreference({ HOME: root, XDG_CONFIG_HOME: root })).toEqual({ browser: "", appWindow: true });
  await mkdir(join(root, "sbar-orbit"), { recursive: true });
  await writeFile(join(root, "sbar-orbit", "panel.json"), JSON.stringify({ viewerBrowser: "chromium-browser", viewerAppWindow: false }));
  expect(await viewerPreference({ HOME: root, XDG_CONFIG_HOME: root })).toEqual({ browser: "chromium-browser", appWindow: false });
  await writeFile(join(root, "sbar-orbit", "panel.json"), "{ not json");
  expect(await viewerPreference({ HOME: root, XDG_CONFIG_HOME: root })).toEqual({ browser: "", appWindow: true });
  await rm(root, { recursive: true, force: true });
});

test("an unset choice prefers a browser that can give the viewer a window", async () => {
  const { pickBrowser } = await import("../src/host-browsers");
  const zen = { id: "zen", name: "Zen", command: ["zen"], appWindow: false, isDefault: true };
  const chrome = { id: "chrome", name: "Chrome", command: ["chrome"], appWindow: true, isDefault: false };
  // The desktop default cannot open an app window, so the first browser that can takes its place.
  expect(pickBrowser([zen, chrome])!.id).toBe("chrome");
  // Unless app windows are switched off, when the desktop's own default is the right answer again.
  expect(pickBrowser([zen, chrome], "", false)!.id).toBe("zen");
  // An explicit choice is always honoured, and a choice that is gone falls back rather than failing.
  expect(pickBrowser([zen, chrome], "zen")!.id).toBe("zen");
  expect(pickBrowser([zen, chrome], "removed")!.id).toBe("chrome");
  expect(pickBrowser([])).toBeUndefined();
});

test("a browser that refuses its arguments is not reported as opened", async () => {
  const { openViewer } = await import("../src/host-browsers");
  const root = await mkdtemp(join(tmpdir(), "orbit-open-"));
  const applications = join(root, "applications");
  await mkdir(applications, { recursive: true });
  const entry = (name: string, exec: string) => writeFile(join(applications, name),
    `[Desktop Entry]\nName=${name}\nType=Application\nExec=${exec} %U\nCategories=Network;WebBrowser;\nMimeType=x-scheme-handler/http;\n`);
  // `false` is a browser that starts and exits nonzero, which is what a rejected flag looks like.
  await entry("chromium-refuses.desktop", "/usr/bin/false");
  const env = { HOME: root, XDG_DATA_HOME: root, XDG_DATA_DIRS: "" };
  expect(await openViewer("http://127.0.0.1:1/#t", "", true, env))
    .toEqual({ opened: false, browser: "chromium-refuses", appWindow: false });
  // Exiting at once with zero is the forwarded second invocation, and it is how the window opens.
  await entry("chromium-forwards.desktop", "/usr/bin/true");
  expect(await openViewer("http://127.0.0.1:1/#t", "chromium-forwards", true, env))
    .toEqual({ opened: true, browser: "chromium-forwards", appWindow: true });
  await rm(root, { recursive: true, force: true });
});

test("the fallback prefers Chrome over Chromium rather than whichever sorts first", async () => {
  const { pickBrowser } = await import("../src/host-browsers");
  const browser = (id: string, name: string) => ({ id, name, command: [`/usr/bin/${id}`], appWindow: true, isDefault: false });
  const zen = { id: "zen", name: "Zen", command: ["zen"], appWindow: false, isDefault: true };
  const list = [zen, browser("chromium-browser", "Chromium"), browser("google-chrome", "Google Chrome"), browser("microsoft-edge", "Edge")];
  expect(pickBrowser(list)!.id).toBe("google-chrome");
  expect(pickBrowser([zen, browser("microsoft-edge", "Edge"), browser("helium", "Helium")])!.id).toBe("microsoft-edge");
});
