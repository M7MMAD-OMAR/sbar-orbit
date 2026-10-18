import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sealRelease } from "../src/managed-identity";

/** Complete test release inputs. Stub programs are never executed as platform acceptance. */
export async function releaseFixture(directory: string, version: string, stamp = true, runtime = process.execPath) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "sbar-orbit", version }),
    "bun.lock": "{}\n", "bin/sbar-orbit": "#!/bin/sh\nexit 0\n",
    "bin/sbar-orbit.cmd": "@echo off\r\nexit /b 0\r\n",
    "src/cli.ts": "export {};\n", "src/mcp.ts": "export {};\n", "scripts/limited.ts": "export {};\n",
  };
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: name.startsWith("bin/") ? 0o700 : 0o600 });
  }
  if (stamp) await sealRelease(directory, version, await realpath(runtime));
  return directory;
}
