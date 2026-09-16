$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src

# The biggest remaining failure cause is symlinks. Orbit uses one for a real reason: update.ts keeps
# versions side by side and repoints a single link by rename, so no reader ever sees the name missing.
# On Windows a file symlink needs elevation or Developer Mode, which an agent host cannot assume.
#
# A directory JUNCTION needs neither. The question is whether a junction can carry the same atomic
# repoint, because if it cannot the update design has to change rather than the call.
$probe = @'
import { symlink, rename, mkdir, writeFile, rm, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const say = (m: string) => console.log("[s] " + m);
const base = join(tmpdir(), "orbit-link-" + Math.random().toString(36).slice(2, 8));
await mkdir(join(base, "v1"), { recursive: true });
await mkdir(join(base, "v2"), { recursive: true });
await writeFile(join(base, "v1", "which"), "one");
await writeFile(join(base, "v2", "which"), "two");

// 1. Is Developer Mode on? That single registry value decides whether an unelevated symlink works.
const reg = Bun.spawnSync(["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock", "/v", "AllowDevelopmentWithoutDevLicense"]);
say("developer mode key: " + (reg.stdout.toString().match(/0x\d+/)?.[0] ?? "absent"));

// 2. A plain directory symlink, unelevated.
try {
  await symlink(join(base, "v1"), join(base, "link-sym"), "dir");
  say("symlink(dir): created");
} catch (error) { say("symlink(dir): FAILED " + (error as { code?: string }).code); }

// 3. A junction, which is what Windows offers without elevation.
const mk = Bun.spawnSync(["cmd", "/c", "mklink", "/J", join(base, "link-j"), join(base, "v1")]);
say("mklink /J: exit " + mk.exitCode + " " + mk.stdout.toString().trim().slice(0, 60));
try { say("  junction reads: " + await Bun.file(join(base, "link-j", "which")).text()); }
catch (error) { say("  junction read FAILED: " + (error as Error).message.slice(0, 80)); }

// 4. THE question: can a junction be repointed atomically by rename, the way update.ts does it?
//    A new junction is made under a temporary name, then renamed over the live one.
const mk2 = Bun.spawnSync(["cmd", "/c", "mklink", "/J", join(base, "link-tmp"), join(base, "v2")]);
say("second junction: exit " + mk2.exitCode);
try {
  await rename(join(base, "link-tmp"), join(base, "link-j"));
  say("rename over live junction: ok");
  say("  now reads: " + await Bun.file(join(base, "link-j", "which")).text());
} catch (error) { say("rename over live junction: FAILED " + (error as { code?: string }).code + " " + (error as Error).message.slice(0, 90)); }

// 5. Does node:fs see a junction as a link, which is what the update code inspects?
try { say("readlink(junction): " + (await readlink(join(base, "link-j"))).slice(-14)); }
catch (error) { say("readlink(junction): FAILED " + (error as { code?: string }).code); }
try { say("realpath(junction): " + (await realpath(join(base, "link-j"))).slice(-14)); }
catch (error) { say("realpath(junction): FAILED " + (error as { code?: string }).code); }

// 6. And can a reader hold a file open THROUGH the junction while it is repointed? That is the
//    property the design actually depends on, not the rename alone.
const held = await Bun.file(join(base, "link-j", "which")).text();
const mk3 = Bun.spawnSync(["cmd", "/c", "mklink", "/J", join(base, "link-tmp2"), join(base, "v1")]);
if (mk3.exitCode === 0) {
  try {
    await rename(join(base, "link-tmp2"), join(base, "link-j"));
    say("repoint while a reader had read: ok, was " + held + " now " + await Bun.file(join(base, "link-j", "which")).text());
  } catch (error) { say("second repoint FAILED: " + (error as { code?: string }).code); }
}
await rm(base, { recursive: true, force: true });
say("done");
'@
Set-Content -Path C:\orbit\src\linkprobe.ts -Value $probe -Encoding UTF8
Say ((& C:\orbit\bun.exe run C:\orbit\src\linkprobe.ts 2>&1 | Out-String).Trim())
Remove-Item C:\orbit\src\linkprobe.ts -Force -EA SilentlyContinue
