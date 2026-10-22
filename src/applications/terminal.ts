import { OrbitError } from "../errors";
import { expandDesktopArguments, parseDesktopExec } from "./desktop-entry";
import { resolveExecutable } from "./executable";
import { assertEnabledRegistration } from "./launch-policy";
import { findApplicationRegistration } from "./registration";
import type { DiscoveryOptions } from "./types";

/** Keep terminal-hosted commands in an installed terminal's ordinary user state. */
export async function terminalInvocation(argv: string[], options: DiscoveryOptions): Promise<string[]> {
  const env = options.env ?? process.env;
  try { return [await resolveExecutable("xdg-terminal-exec", env), ...argv]; }
  catch (error) { if (!(error instanceof OrbitError) || error.code !== "UNSUPPORTED") throw error; }
  const terminals = [
    { id: "org.gnome.Ptyxis.desktop", flags: ["--"] },
    { id: "org.kde.konsole.desktop", flags: ["-e"] },
    { id: "org.gnome.Terminal.desktop", flags: ["--"] },
  ];
  for (const terminal of terminals) {
    try {
      const { registration, fields } = await findApplicationRegistration(terminal.id, options);
      assertEnabledRegistration(fields);
      if (fields.Terminal === "true") continue;
      const args = parseDesktopExec(fields.Exec ?? "");
      const command = args.shift();
      if (!command || command.includes("%")) continue;
      const executable = await resolveExecutable(command, env);
      if (fields.TryExec) await resolveExecutable(fields.TryExec, env);
      return [executable, ...expandDesktopArguments(args, fields, terminal.id, registration), ...terminal.flags, ...argv];
    } catch (error) {
      if (!(error instanceof OrbitError) || error.code !== "UNSUPPORTED") throw error;
    }
  }
  throw new OrbitError("UNSUPPORTED", "Terminal=true needs xdg-terminal-exec or an installed Ptyxis, Konsole or GNOME Terminal registration");
}
