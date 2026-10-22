import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { OrbitError } from "./errors";
import { expandDesktopArguments, parseDesktopExec } from "./applications/desktop-entry";
import { resolveExecutable } from "./applications/executable";
import { terminalInvocation } from "./applications/terminal";
import { assertEnabledRegistration } from "./applications/launch-policy";
import { findApplicationRegistration } from "./applications/registration";
import type { DiscoveryOptions, ResolvedApplication } from "./applications/types";

/** Execute the installed registration unchanged, including its original setup and profile. */
export async function resolveInstalledApplication(applicationId: string, options: DiscoveryOptions = {}): Promise<ResolvedApplication> {
  const { registration, fields, env } = await findApplicationRegistration(applicationId, options);
  assertEnabledRegistration(fields);
  const args = parseDesktopExec(fields.Exec ?? "");
  const command = args.shift();
  if (!command || command.includes("%")) throw new OrbitError("INVALID_REQUEST", "Application registration has no literal executable");
  const path = await resolveExecutable(command, env);
  if (fields.TryExec) await resolveExecutable(fields.TryExec, env);
  let argv = [path, ...expandDesktopArguments(args, fields, applicationId, registration)];
  if (fields.Terminal === "true") argv = await terminalInvocation(argv, options);
  let cwd: string | undefined;
  if (fields.Path) {
    if (!isAbsolute(fields.Path) || /[$`\0]/.test(fields.Path)) throw new OrbitError("INVALID_REQUEST", "Application working directory must be literal and absolute");
    cwd = await realpath(fields.Path).catch(() => undefined);
    if (!cwd || !(await stat(cwd)).isDirectory()) throw new OrbitError("INVALID_REQUEST", "Application working directory is unavailable");
  }
  if (argv.length > 128 || argv.some(arg => arg.length > 4096)) throw new OrbitError("INVALID_REQUEST", "Application launch recipe exceeds argument limits");
  const busName = fields.DBusActivatable === "true" ? applicationId.replace(/\.desktop$/, "") : undefined;
  const activation = busName && /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/.test(busName) ? { busName } : {};
  return { argv, ...(cwd ? { cwd } : {}), ...activation, applicationId };
}
