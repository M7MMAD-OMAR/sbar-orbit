import { readFile } from "node:fs/promises";

export async function distributionName(): Promise<{ id: string; versionId: string }> {
  const release = await readFile("/etc/os-release", "utf8").catch(() => "");
  const field = (key: string) => (new RegExp(`^${key}="?([^"\n]*)"?$`, "m").exec(release)?.[1] ?? "").slice(0, 32);
  return { id: field("ID"), versionId: field("VERSION_ID") };
}

/**
 * The tar this platform's archives are made for. On Windows `tar` on PATH can be the one that ships
 * with Git for Windows, a GNU tar that reads `C:\x` as host `C` and fails with "Cannot connect to C".
 * The bsdtar in System32 has been part of Windows since 10 build 17063 and takes drive paths.
 */
export function tarExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "tar";
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return `${root}\\System32\\tar.exe`;
}

/** Programs that ship in System32 and that a Git for Windows or MSYS PATH can shadow with a GNU build. */
const systemTools = new Set(["whoami.exe", "schtasks.exe", "powershell.exe", "reg.exe", "icacls.exe", "taskkill.exe", "tar.exe"]);

/**
 * Resolve a bare Windows system tool to its System32 path. `whoami.exe` on a runner or a developer
 * shell with Git for Windows first on PATH is GNU whoami and rejects `/user`; measured on a GitHub
 * windows-latest runner. Other argv and other platforms pass through unchanged.
 */
export function systemArgv(argv: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const [command, ...rest] = argv;
  if (platform !== "win32" || command === undefined || !systemTools.has(command.toLowerCase())) return argv;
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  const directory = command.toLowerCase() === "powershell.exe" ? "System32\\WindowsPowerShell\\v1.0" : "System32";
  return [`${root}\\${directory}\\${command}`, ...rest];
}
