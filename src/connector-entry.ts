import { parseRuntimeReceipt, RUNTIME_RECEIPT } from "./windows-runtime-source";
import { version } from "../package.json";
import { preparedIdentitySync } from "./managed-identity";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DESKTOP_LAUNCHER, DESKTOP_MANIFEST, DESKTOP_RUNTIME, parseDesktopManifest } from "./windows-desktop-update";

/**
 * How an agent host is told to start Orbit's MCP adapter.
 *
 * One implementation, because two of them drifted: the installer wrote one shape into
 * `~/.config/sbar-orbit/mcp.json` and `connector-config` printed another, and both named an
 * interpreter and a source file directly.
 *
 * The launcher is the portable answer and a source path is not, for three separate reasons:
 *
 *   - **It survives an upgrade.** The launcher link is the one path `local-install.ts` switches
 *     atomically between versions. Configuration written against `<checkout>/src/mcp.ts` points at
 *     the version that happened to be installed the day it was written, and a rollback leaves the
 *     agent host running the newer code against the older broker.
 *   - **It finds its own Bun.** `bin/sbar-orbit` resolves the interpreter by location rather than
 *     from the caller's PATH, which is why a systemd user service stopped exiting 127 on an Ubuntu
 *     runner on 14 September 2026. Naming `process.execPath` in the configuration hardcodes whichever
 *     Bun ran the installer, so moving or replacing that Bun breaks the connector silently.
 *   - **It does not name a checkout.** A registry install lives under whichever `BUN_INSTALL` home
 *     resolved it, and a checkout is wherever the person put it. The launcher is the only stable
 *     name either of them has.
 *
 * Windows has a launcher of its own now, `bin/sbar-orbit.cmd`, and it is named the same way with one
 * difference stated rather than smoothed over. A `.cmd` is not an image the kernel executes, so
 * whether a host can start it depends on how that host spawns. Measured on the guest: Bun's own
 * spawn started it both verbatim, exactly as this configuration reads, and through `cmd.exe`. A host
 * calling Node's `child_process.spawn` without `shell: true` cannot.
 *
 * `preferInterpreter` is the way out for such a host, and it is honoured on EVERY platform rather
 * than on Windows alone. The Linux launcher is a bash script with no extension, which is its own
 * reason a host might refuse to spawn it, and a flag that silently did nothing there would be worse
 * than no flag: the person would register the same configuration they already had and conclude the
 * problem was elsewhere. `sbar-orbit connector-config --no-launcher` is how a person reaches it.
 */
/** A native image is usable only through its sealed managed source, never by an exe name/env hint. */
function nativeWindowsConnector(source: string) {
  source = resolve(source);
  const root = basename(dirname(source)) === "versions" ? dirname(dirname(source))
    : basename(source) === "current" && existsSync(source + ".txt") ? dirname(source) : null;
  if (!root || !existsSync(join(root, "windows-bootstrap.json"))) return null;
  const refuse = (): never => { throw new Error("Managed native Windows connector identity differs; recover deliberately"); };
  const json = (path: string) => {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || realpathSync(path) !== path) refuse();
    return JSON.parse(readFileSync(path, "utf8"));
  };
  if (realpathSync(root) !== root) refuse();
  if (existsSync(join(root, "activation-recovery.json"))) refuse();
  const pointer = join(root, "current.txt"), pointerInfo = lstatSync(pointer);
  if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink() || pointerInfo.size > 32768) refuse();
  const target = readFileSync(pointer, "utf8").replace(/\r?\n$/, "");
  if (target !== resolve(target) || dirname(target) !== join(root, "versions") || realpathSync(target) !== target) refuse();
  if (source !== join(root, "current")) preparedIdentitySync(root, basename(source));
  const selectedVersion = basename(target), selected = preparedIdentitySync(root, selectedVersion);
  if (selected.runtime !== join(target, DESKTOP_RUNTIME)) refuse();
  const selectedManifest = parseDesktopManifest(json(join(target, DESKTOP_MANIFEST)), selectedVersion);
  if (selected.runtimeDigest !== selectedManifest.runtimeSource.executableSha256) refuse();
  parseRuntimeReceipt(json(join(target, RUNTIME_RECEIPT)), selectedManifest.runtimeSource, selectedVersion);
  const bootstrap = json(join(root, "windows-bootstrap.json"));
  if (bootstrap.schema !== 2 || bootstrap.bootstrapProtocol !== 2 || typeof bootstrap.version !== "string" || !/^[a-f0-9]{64}$/.test(bootstrap.launcherDigest)) refuse();
  const origin = join(root, "versions", bootstrap.version);
  preparedIdentitySync(root, bootstrap.version);
  const manifest = parseDesktopManifest(json(join(origin, DESKTOP_MANIFEST)), bootstrap.version);
  const native = join(root, "bin/Orbit.exe"), info = lstatSync(native);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024 || realpathSync(native) !== native
      || manifest.files.find(file => file.path === DESKTOP_LAUNCHER)?.sha256 !== bootstrap.launcherDigest
      || createHash("sha256").update(readFileSync(native)).digest("hex") !== bootstrap.launcherDigest) refuse();
  return { command: native, args: ["--cli", root, "mcp"] };
}

export function connectorEntry(options: { launcher?: string; source: string; platform?: string; interpreter?: string; preferInterpreter?: boolean }) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const native = nativeWindowsConnector(options.source);
    // --no-launcher means no shell script, not a version-pinned interpreter when a verified native image exists.
    if (native) return native;
  }
  const launcher = platform === "win32" ? windowsLauncher(options.launcher) : options.launcher;
  if (launcher && !options.preferInterpreter) return { command: launcher, args: ["mcp"] };
  if (platform === "win32" && existsSync(`${options.source}.txt`)) {
    const root = dirname(options.source), entry = join(root, "managed-entry.ts");
    const identity = JSON.parse(readFileSync(join(root, "managed-entry-identity.json"), "utf8"));
    if (options.source !== join(root, "current") || realpathSync(root) !== root || lstatSync(entry).isSymbolicLink() ||
      identity.schema !== 1 || identity.root !== root || identity.digest !== createHash("sha256").update(readFileSync(entry)).digest("hex"))
      throw new Error("Managed interpreter entry ownership differs; migrate deliberately");
    if (!lstatSync(`${options.source}.txt`).isFile() || lstatSync(`${options.source}.txt`).isSymbolicLink())
      throw new Error("Managed pointer must be a regular installation file");
    const target = readFileSync(`${options.source}.txt`, "utf8").replace(/\r?\n$/, "");
    if (dirname(target) !== join(root, "versions") || realpathSync(target) !== target)
      throw new Error("Managed interpreter pointer is outside its admitted root");
    const record = preparedIdentitySync(root, target.slice(join(root, "versions").length + 1));
    if (options.interpreter !== undefined && options.interpreter !== record.runtime)
      throw new Error("Interpreter differs from the installed runtime pin");
    return { command: record.runtime, args: [entry, "mcp"] };
  }
  return { command: options.interpreter ?? process.execPath, args: [join(options.source, "src/mcp.ts")] };
}

/**
 * The Windows launcher beside a path that may name the POSIX one.
 *
 * The installer and `connector-config` both hand over whichever launcher they know about, and on
 * Windows that is the extensionless bash script when the caller built the path rather than being
 * invoked through it. Adding the suffix here keeps one rule in one place instead of two callers
 * remembering it.
 */
function windowsLauncher(launcher?: string) {
  if (!launcher) return undefined;
  return /\.(cmd|bat)$/i.test(launcher) ? launcher : `${launcher}.cmd`;
}

/** A release change gives host configuration watchers a new adapter fingerprint. */
export function connectorEnvironment(socket: string) {
  return { ORBIT_SOCKET: socket, ORBIT_CLIENT_VERSION: version };
}
