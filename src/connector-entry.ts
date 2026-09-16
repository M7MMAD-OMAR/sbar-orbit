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
 * Windows is the exception, and it is stated rather than smoothed over: `bin/sbar-orbit` is a shell
 * script, so there is nothing for an agent host to execute. There the interpreter and the module are
 * named directly, which is the same entry point one level down. When Windows grows a launcher of its
 * own this is the single place that has to learn about it.
 */
export function connectorEntry(options: { launcher?: string; source: string; platform?: string; interpreter?: string }) {
  const platform = options.platform ?? process.platform;
  if (options.launcher && platform !== "win32") return { command: options.launcher, args: ["mcp"] };
  return { command: options.interpreter ?? process.execPath, args: [join(options.source, "src/mcp.ts")] };
}
