$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\orbit-upd2.tgz 2>&1 | Out-Null
Say ("unpack exit=" + $LASTEXITCODE)

# The Linux suite exercises the Windows branch by pretending to be win32. That is worth having, but a
# simulated platform is not the platform: only a real run proves the rename is actually permitted and
# actually atomic here. This drives the SHIPPED update.ts on the guest, unelevated.
$probe = @'
import { activateVersion, currentVersion, layout, pruneVersions, updateRoot, defaultLauncherPath, launcherName } from "./src/update";
import { mkdtemp, mkdir, writeFile, rm, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const say = (m: string) => console.log("[s] " + m);
const redact = (v: string) => v.replace(process.env.USERPROFILE ?? "@@", "%USERPROFILE%");
say("platform: " + process.platform);
say("updateRoot: " + redact(updateRoot()));
say("launcher: " + redact(defaultLauncherPath()));
say("launcherName: " + launcherName());

const root = await mkdtemp(join(tmpdir(), "orbit-win-"));
const paths = layout(root);
for (const version of ["1.0.0", "2.0.0"]) {
  await mkdir(join(paths.versions, version, "bin"), { recursive: true });
  await writeFile(join(paths.versions, version, launcherName()), "@echo off\n");
}
const environment = { root, openSessions: async () => 0, restart: async () => ({ ok: true, output: "" }), healthy: async () => true };

say("current before: " + await currentVersion(root));
const first = await activateVersion("1.0.0", environment);
say("activate 1.0.0: " + JSON.stringify({ activated: first.activated }));
say("current: " + await currentVersion(root));
say("pointer file exists: " + await Bun.file(paths.current + ".txt").exists());
say("plain 'current' created: " + await Bun.file(paths.current).exists());

const second = await activateVersion("2.0.0", environment);
say("activate 2.0.0: " + JSON.stringify({ activated: second.activated }));
say("current: " + await currentVersion(root));
say("previous pointer: " + (await Bun.file(paths.previous + ".txt").text()).split(/[\\/]/).pop());

// The property the design depends on: a reader holding the pointer OPEN across a swap.
const reader = Bun.file(paths.current + ".txt").stream().getReader();
const third = await activateVersion("1.0.0", environment);
say("swap with an OPEN reader: " + (third.activated ? "ok" : "REFUSED " + third.reason));
try { await reader.cancel(); } catch {}
say("current after: " + await currentVersion(root));

// And the prune must not delete the rollback target, which is what the backslash split protects.
const pruned = await pruneVersions(root, 0);
say("prune removed: " + JSON.stringify(pruned.removed) + " kept: " + JSON.stringify(pruned.kept.sort()));

try { await readlink(paths.current); say("readlink: UNEXPECTEDLY SUCCEEDED"); }
catch (error) { say("readlink(current): " + (error as { code?: string }).code + " (expected, no symlink was made)"); }

await rm(root, { recursive: true, force: true });
say("done");
'@
Set-Content -Path C:\orbit\src\updprobe.ts -Value $probe -Encoding UTF8
Say ((& C:\orbit\bun.exe run C:\orbit\src\updprobe.ts 2>&1 | Out-String).Trim())
Remove-Item C:\orbit\src\updprobe.ts -Force -EA SilentlyContinue

Say "=== the update suite itself, on the guest ==="
Say ((& C:\orbit\bun.exe test tests/update.test.ts 2>&1 | Out-String).Trim() -split "`n" | Select-Object -Last 8)
