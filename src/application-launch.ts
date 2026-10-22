import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { OrbitError } from "./errors";
import { expandDesktopArguments, parseDesktopExec } from "./applications/desktop-entry";
import { resolveExecutable, resolveNativeExecutable } from "./applications/executable";
import { assertNativeExecutable, assertNativeRegistration, assertNoProfileSelection, requiresCommandAdapter, supportsRenderingValue } from "./applications/launch-policy";
import { findApplicationRegistration } from "./applications/registration";
import type { DiscoveryOptions, ResolvedApplication } from "./applications/types";

const refuse = (message: string): never => { throw new OrbitError("UNSUPPORTED", message); };

/** Resolve an exact registered desktop ID, never an existing-window attachment. */
export async function resolveInstalledApplication(applicationId: string, options: DiscoveryOptions = {}): Promise<ResolvedApplication> {
  const { registration, fields, env, home } = await findApplicationRegistration(applicationId, options);
  assertNativeRegistration(fields, applicationId);
  const exec = fields.Exec;
  if (exec === undefined) return refuse("Application registration has no Exec recipe");
  const args = parseDesktopExec(exec); let command = args.shift();
  if (!command || command.includes("%")) return refuse("Application registration has no literal executable");
  let path = await resolveExecutable(command, env);
  const renderingPrefix: string[] = [];
  if (basename(path) === "env" && await realpath(path) === "/usr/bin/env") {
    const seen = new Set<string>();
    while (args[0]?.includes("=")) {
      const assignment = args.shift() ?? "";
      const [key, value] = assignment.split("=");
      if (!key || assignment.indexOf("=") !== assignment.lastIndexOf("=") || seen.has(key) || !supportsRenderingValue(key, value))
        return refuse("Unsupported application rendering environment assignment");
      seen.add(key); renderingPrefix.push(assignment);
    }
    if (!renderingPrefix.length) refuse("Environment wrappers require an explicit supported rendering value");
    command = args.shift();
    if (!command || command.startsWith("-") || command.includes("%")) return refuse("Rendering wrapper has no literal executable");
    renderingPrefix.unshift(path);
    path = await resolveExecutable(command, env);
  }
  if ([basename(path), basename(await realpath(path))].some(requiresCommandAdapter))
    refuse("Application registration needs an unsupported command adapter");
  if (fields.TryExec) await resolveExecutable(fields.TryExec, env);
  const resolved = await resolveNativeExecutable(path, home, env);
  if ([basename(resolved), basename(await realpath(resolved))].some(requiresCommandAdapter))
    refuse("Application wrapper needs an unsupported command adapter");
  // Resolve aliases and supported wrappers before applying the same native-only admission.
  const resolvedNames = [path, await realpath(path), resolved, await realpath(resolved)];
  assertNativeExecutable(resolvedNames);
  const argv = [...renderingPrefix, resolved, ...expandDesktopArguments(args, fields, applicationId, registration)];
  // Validate the final arguments, including values introduced by field codes.
  assertNoProfileSelection(argv);
  let cwd: string | undefined;
  if (fields.Path) {
    if (!isAbsolute(fields.Path) || /[$`\0]/.test(fields.Path)) refuse("Application working directory must be literal and absolute");
    cwd = await realpath(fields.Path).catch(() => undefined);
    if (!cwd || !(await stat(cwd)).isDirectory()) refuse("Application working directory is unavailable");
  }
  if (argv.length > 128 || argv.some(arg => arg.length > 4096)) refuse("Application launch recipe exceeds argument limits");
  return { argv, ...(cwd ? { cwd } : {}), applicationId };
}
