// Diagnostic evidence for the Windows CI ACL failure, not a passing capability gate.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") throw new Error("Windows only");
const root = await mkdtemp(join(tmpdir(), "orbit-acl-diagnostic-"));
const socket = join(root, "broker.sock");
const file = join(root, "control.txt");
const server = Bun.serve({ unix: socket, fetch: () => new Response("ok") });
try {
  await writeFile(file, "control");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const executable = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  for (const target of [file, socket]) {
    for (const cleanModules of [false, true]) {
      const env = { ...process.env };
      if (cleanModules) for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "psmodulepath") delete env[key];
      }
      const result = Bun.spawnSync([executable, "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath '${target.replace(/'/g, "''")}').Access | ForEach-Object { "$($_.IdentityReference)" }`,
      ], { env, stdout: "pipe", stderr: "pipe" });
      console.log(JSON.stringify({ target: target === file ? "file" : "socket", cleanModules,
        exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }));
    }
  }
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
