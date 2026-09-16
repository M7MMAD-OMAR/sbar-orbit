import { join } from "node:path";

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
 * difference stated rather than smoothed over: a `.cmd` is not an image the kernel can execute, so an
 * agent host has to run it through `cmd.exe`, and not every host does. A host that refuses it can be
 * pointed at the interpreter and `src/mcp.ts` instead, which is the same entry point one level down,
 * and `windowsFallback` is that switch. Nothing else in the project has to know the difference.
 */
export function connectorEntry(options: { launcher?: string; source: string; platform?: string; interpreter?: string; windowsFallback?: boolean }) {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const launcher = windows ? windowsLauncher(options.launcher) : options.launcher;
  if (launcher && !(windows && options.windowsFallback)) return { command: launcher, args: ["mcp"] };
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
