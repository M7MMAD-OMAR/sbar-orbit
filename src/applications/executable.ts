import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { OrbitError } from "../errors";

const refuse = (message: string): never => { throw new OrbitError("UNSUPPORTED", message); };

export async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const searchPath = (env.PATH ?? "").split(":");
  if (!isAbsolute(command) && searchPath.some(path => !isAbsolute(path)))
    refuse("Application PATH contains relative or empty entries; refusing a different installation");
  const candidates = isAbsolute(command) ? [command] : command.includes("/") ? [] :
    searchPath.map(path => join(path, command));
  if (candidates.length > 128) refuse("Application PATH discovery is incomplete");
  for (const candidate of candidates) {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (!canonical) continue;
    const entry = await stat(canonical).catch(() => undefined);
    // The invoked alias can select a program mode. Canonical identity is only for validation.
    if (entry?.isFile() && entry.mode & 0o111) return candidate;
  }
  return refuse("Registered application executable is unavailable");
}
