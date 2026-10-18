import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, dirname, sep, isAbsolute, resolve } from "node:path";

// Copied beside current.txt. No relative imports: this stable entry survives
// pruning a previous package and is usable by hosts that cannot execute .cmd.
export async function managedTarget(root: string): Promise<string> {
  const pointerInfo = await lstat(join(root, "current.txt"));
  if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink()) throw new Error("Managed pointer must be a regular installation file");
  const pointer = (await readFile(join(root, "current.txt"), "utf8")).replace(/\r?\n$/, "");
  if (!isAbsolute(pointer) || /[\r\n]/.test(pointer) || pointer !== resolve(pointer)) throw new Error("Managed pointer must be canonical and absolute");
  const versions = await realpath(join(root, "versions"));
  if (versions !== join(resolve(root), "versions")) throw new Error("Managed versions storage differs from its admitted root");
  const target = await realpath(pointer);
  if (target !== pointer) throw new Error("Managed pointer must not traverse a redirected release");
  const version = target.slice(versions.length + 1);
  if (!target.startsWith(versions + sep) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version))
    throw new Error("Managed pointer must name one prepared version");
  const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  if (manifest.name !== "sbar-orbit" || manifest.version !== version || !(await stat(join(target, "bin/sbar-orbit.cmd"))).isFile())
    throw new Error("Managed pointer does not name a complete Orbit release");
  const record = JSON.parse(await readFile(join(target, "orbit-release-identity.json"), "utf8"));
  const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  if (!(await lstat(join(target, "orbit-release-identity.json"))).isFile() ||
    (await lstat(join(target, "orbit-release-identity.json"))).isSymbolicLink() ||
    Object.keys(record).sort().join(",") !== "archiveIntegrity,releaseDigest,runtime,runtimeDigest,schema,version" ||
    !(record.archiveIntegrity === null || typeof record.archiveIntegrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.archiveIntegrity)) ||
    !/^[a-f0-9]{64}$/.test(record.releaseDigest) || !/^[a-f0-9]{64}$/.test(record.runtimeDigest) ||
    record.schema !== 1 || record.version !== version || !isAbsolute(record.runtime) ||
    await realpath(record.runtime) !== record.runtime || !(await lstat(record.runtime)).isFile() ||
    hash(await readFile(record.runtime)) !== record.runtimeDigest)
    throw new Error("Managed release exact runtime identity is invalid; migrate deliberately");
  for (const relative of ["package.json", "bun.lock", "bin/sbar-orbit", "bin/sbar-orbit.cmd", "src/cli.ts", "src/mcp.ts", "scripts/limited.ts"]) {
    const info = await lstat(join(target, relative));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Managed pointer names an incomplete release");
  }
  const files: [string, string][] = [];
  async function visit(relative: string, required = false) {
    const path = join(target, relative);
    const info = await lstat(path).catch(error => { if (!required && error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error("Managed release inputs must be regular");
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(`${relative}/${name}`, true);
    else if (info.isFile()) files.push([relative, hash(await readFile(path))]);
    else throw new Error("Managed release inputs must be regular");
  }
  for (const name of ["package.json", "bun.lock", "bunfig.toml", "bin", "src", "scripts", "desktop", "viewer", "docs", "install.sh", "install.cmd", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"])
    await visit(name, ["package.json", "bun.lock", "bin", "src", "scripts"].includes(name));
  if (hash(JSON.stringify(files)) !== record.releaseDigest) throw new Error("Managed release bytes changed; migrate deliberately");
  return target;
}

export async function runManagedEntry(root: string, args: string[]) {
  const target = await managedTarget(root);
  const record = JSON.parse(await readFile(join(target, "orbit-release-identity.json"), "utf8"));
  const runtime: string = record.runtime;
  if (process.env.ORBIT_BUN !== undefined && process.env.ORBIT_BUN !== runtime)
    throw new Error("Managed entry runtime differs from the installed release pin");
  const command = args[0] ?? "help", rest = args.slice(1);
  let argv: string[];
  if (command === "mcp" || command === "connector-config") {
    argv = [join(target, `src/${command}.ts`), ...rest];
  } else if (command === "preflight") argv = [join(target, "scripts/preflight.ts"), ...rest];
  else if (command === "status" && rest.includes("--watch")) argv = [join(target, "src/status.ts"), "--watch"];
  else if (command === "serve" || command === "install") {
    argv = [join(target, "scripts/limited.ts"), runtime, "run",
      join(target, command === "install" ? "scripts/install.ts" : "src/cli.ts"),
      ...(command === "serve" ? ["serve"] : []), ...rest];
  } else if (["service", "autostart", "panel", "settings", "config", "desktop", "native"].includes(command)) {
    throw new Error(`${command} is unavailable in the Windows managed installation`);
  } else argv = [join(target, "src/cli.ts"), ...args];
  const child = Bun.spawn([runtime, "run", ...argv], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env,
  });
  return child.exited;
}

if (import.meta.main) {
  try { process.exitCode = await runManagedEntry(dirname(import.meta.path), process.argv.slice(2)); }
  catch (error) { console.error(`sbar-orbit: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
}
