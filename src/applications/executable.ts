import { open, realpath, stat } from "node:fs/promises";
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

export async function resolveNativeExecutable(path: string, home: string, env: NodeJS.ProcessEnv, visited = new Set<string>()): Promise<string> {
  const identity = await realpath(path);
  if (visited.has(identity) || visited.size >= 8) refuse("Application wrapper chain is cyclic or too deep");
  visited.add(identity);
  const handle = await open(path, "r");
  let content: string, exceedsLimit: boolean;
  try {
    const bytes = Buffer.alloc(8193);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    content = bytes.subarray(0, result.bytesRead).toString();
    exceedsLimit = result.bytesRead > 8192 || (await handle.stat()).size > 8192;
  }
  finally { await handle.close(); }
  if (!content.startsWith("#!")) return path;
  if (content.includes("\r")) refuse("Application wrapper carriage returns are unsupported");
  // Installed native applications can use an interpreter as their entry point.
  // This does not admit interpreter command-line evaluation or shell setup.
  const shebang = content.split("\n", 1)[0] ?? "";
  const nativeScript = /^#![ \t]*(\/usr\/bin\/(?:python3(?:\.\d+)?|gjs(?:-console)?))([ \t]+-m)?[ \t]*$/.exec(shebang);
  if (nativeScript?.[1] && (!nativeScript[2] || nativeScript[1].includes("gjs"))) {
    const interpreterPath = await realpath(nativeScript[1]).catch(() => undefined);
    const interpreterInfo = interpreterPath ? await stat(interpreterPath).catch(() => undefined) : undefined;
    if (!interpreterPath?.startsWith("/usr/bin/") || !interpreterInfo?.isFile()
        || interpreterInfo.uid !== 0 || interpreterInfo.mode & 0o022 || !(interpreterInfo.mode & 0o111))
      refuse("Native application interpreter is not a trusted system executable");
    return path;
  }
  if (exceedsLimit) refuse("Application wrapper exceeds supported size");
  const lines = content.split(/\r?\n/); const interpreter = lines.shift() ?? "";
  if (!/^#![ \t]*\/(?:usr\/)?bin\/(?:ba|da)?sh[ \t]*$/.test(interpreter))
    refuse("Application script requires an unsupported interpreter launch recipe");
  const statements = lines.map(line => line.replace(/^[ \t]+|[ \t]+$/g, "")).filter(line => line && !line.startsWith("#"));
  if (statements.length !== 1) refuse("Application shell wrapper requires an explicit supported launch recipe");
  const match = /^exec (?:"([^"\r\n]+)"|([^\s"']+)) "\$@"$/.exec(statements[0] ?? "");
  if (!match) refuse("Application shell wrapper requires an explicit supported launch recipe");
  let target = match?.[1] ?? match?.[2] ?? "";
  if ((!match?.[1] && !/^[A-Za-z0-9_./:+-]+$/.test(target)) || target.startsWith("-"))
    refuse("Unsupported application wrapper expression");
  if (target.startsWith("$HOME/") && match?.[1]) target = home + target.slice(5);
  if (/[$`\\;|&<>\0]/.test(target)) refuse("Unsupported application wrapper expression");
  return resolveNativeExecutable(await resolveExecutable(target, env), home, env, visited);
}
