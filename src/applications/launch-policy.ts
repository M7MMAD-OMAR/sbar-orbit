import { basename } from "node:path";
import { OrbitError } from "../errors";
import type { DesktopEntry } from "./desktop-entry";

const refuse = (message: string): never => { throw new OrbitError("UNSUPPORTED", message); };

const browserName = /^(?:firefox|chromium|chrome|google-chrome|msedge|microsoft-edge|brave|vivaldi|librewolf|waterfox|floorp|mullvad|mullvad-browser|icecat|seamonkey|opera|thorium|yandex|epiphany|falkon|qutebrowser|zen|helium|surf|midori|luakit|nyxt|netsurf|otter-browser|konqueror|firedragon|cachy-browser|slimjet|sidekick|wavebox)(?:-browser|-bin)?(?:-(?:stable|beta|dev|developer|nightly|esr|unstable|canary))?(?:\.exe)?$/i;
const renderingValues = new Map<string, readonly string[]>([
  ["GSK_RENDERER", ["cairo", "gl", "ngl", "vulkan", "opengl"]],
  ["GDK_BACKEND", ["wayland", "x11", "wayland,x11", "x11,wayland"]],
  ["QT_QPA_PLATFORM", ["wayland", "wayland-egl", "xcb"]],
]);

export function assertNativeRegistration(fields: DesktopEntry, applicationId: string): void {
  if (fields.Type !== "Application" || fields.Hidden === "true" || !fields.Exec) refuse("Application registration is disabled or has no Exec recipe");
  // Classify application identities, never parent directory names or ordinary arguments.
  const registeredName = (fields.Name ?? "").replace(/^(?:Google|Mozilla|Microsoft|GNU) /i, "")
    .replace(/(?: Web)? Browser$/i, "").replaceAll(" ", "-");
  if ((fields.Categories ?? "").split(";").some(value => ["WebBrowser", "TerminalEmulator"].includes(value))
      || [...applicationId.split(/[._]/), registeredName].some(name => browserName.test(name)))
    refuse("Browser and terminal launch routes were removed; choose a supported native application");
  if (fields.Terminal === "true" || fields["X-Flatpak"])
    refuse("Application registration needs an unsupported activation adapter");
}

export function supportsRenderingValue(key: string, value: string | undefined): boolean {
  return renderingValues.get(key)?.includes(value ?? "") ?? false;
}

export function requiresCommandAdapter(name: string): boolean {
  const unsupportedCommands = ["env", "flatpak", "sh", "bash", "dash", "zsh", "fish", "python", "python3", "gjs", "gjs-console", "node", "bun", "xdg-open", "gio", "sensible-browser"];
  return unsupportedCommands.includes(name) || /^python(?:[0-9]+(?:\.[0-9]+)*)?$/.test(name);
}

export function assertNativeExecutable(paths: string[]): void {
  const terminalName = /^(?:gnome-terminal|gnome-console|kgx|konsole|xterm|kitty|alacritty|foot|wezterm|tilix|ptyxis)(?:[.-].*)?$/i;
  if (paths.some(name => browserName.test(basename(name)) || terminalName.test(basename(name))))
    refuse("Resolved browser or terminal executables are unavailable through native opening");
}

export function assertNoProfileSelection(argv: string[]): void {
  for (const arg of argv.slice(1)) {
    if (/^(?:--?profile|--profile-directory|--user-data-dir)(?:=|$)/i.test(arg) || /^-P(?:$|[^a-z])/.test(arg))
      refuse("Registered profile selection requires a separate supported state adapter");
  }
}
