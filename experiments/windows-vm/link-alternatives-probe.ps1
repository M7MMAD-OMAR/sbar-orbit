$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src

# Rename over a live junction is EPERM, so the atomic repoint update.ts depends on does not port.
# Before the design changes, the alternatives get measured rather than assumed:
#   A. delete then recreate the junction, which has a window where the name does not exist
#   B. a pointer FILE holding the version name, swapped by rename, which IS atomic on Windows
#   C. whether a junction can be repointed in place by reopening its reparse point
$probe = @'
import { mkdir, writeFile, rename, rm, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const say = (m: string) => console.log("[s] " + m);
const base = join(tmpdir(), "orbit-alt-" + Math.random().toString(36).slice(2, 8));
await mkdir(join(base, "v1"), { recursive: true });
await mkdir(join(base, "v2"), { recursive: true });
await writeFile(join(base, "v1", "which"), "one");
await writeFile(join(base, "v2", "which"), "two");
const link = join(base, "current");

// A. delete then recreate.
Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, join(base, "v1")]);
say("A start: " + await Bun.file(join(link, "which")).text());
const t0 = Bun.nanoseconds();
try {
  await rmdir(link);
  const gap = Bun.nanoseconds() - t0;
  const re = Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, join(base, "v2")]);
  const total = Bun.nanoseconds() - t0;
  say(`A rmdir+mklink: exit ${re.exitCode}, name absent for ${(gap / 1e6).toFixed(2)}ms, total ${(total / 1e6).toFixed(2)}ms`);
  say("A now: " + await Bun.file(join(link, "which")).text());
} catch (error) { say("A FAILED: " + (error as { code?: string }).code); }

// B. a pointer file swapped by rename. This is the shape that does not need a link at all.
const pointer = join(base, "current.txt");
await writeFile(pointer, "v1");
const temporary = join(base, "current.txt.new");
await writeFile(temporary, "v2");
const t1 = Bun.nanoseconds();
try {
  await rename(temporary, pointer);
  say(`B rename over existing FILE: ok in ${((Bun.nanoseconds() - t1) / 1e6).toFixed(2)}ms, reads ${await readFile(pointer, "utf8")}`);
} catch (error) { say("B FAILED: " + (error as { code?: string }).code); }

// B2. and the property that matters: a reader holding the file open during the swap.
await writeFile(pointer, "v1");
const handle = await Bun.file(pointer).text();
await writeFile(temporary, "v2");
try {
  await rename(temporary, pointer);
  say(`B2 swap while a reader had read: ok, was ${handle} now ${await readFile(pointer, "utf8")}`);
} catch (error) { say("B2 FAILED: " + (error as { code?: string }).code); }

// B3. can it be swapped while a process holds the file OPEN, not merely having read it?
await writeFile(pointer, "v1");
const open = Bun.file(pointer).stream().getReader();
await writeFile(temporary, "v2");
try {
  await rename(temporary, pointer);
  say("B3 swap with an OPEN reader: ok");
} catch (error) { say("B3 swap with an OPEN reader: FAILED " + (error as { code?: string }).code); }
try { await open.cancel(); } catch {}

// C. is the EPERM about the junction being a DIRECTORY, or about it being a reparse point?
await mkdir(join(base, "plaindir"), { recursive: true });
await mkdir(join(base, "plaindir2"), { recursive: true });
try {
  await rename(join(base, "plaindir2"), join(base, "plaindir"));
  say("C rename over an existing plain DIRECTORY: ok");
} catch (error) { say("C rename over an existing plain DIRECTORY: FAILED " + (error as { code?: string }).code); }

await rm(base, { recursive: true, force: true });
say("done");
'@
Set-Content -Path C:\orbit\src\altprobe.ts -Value $probe -Encoding UTF8
Say ((& C:\orbit\bun.exe run C:\orbit\src\altprobe.ts 2>&1 | Out-String).Trim())
Remove-Item C:\orbit\src\altprobe.ts -Force -EA SilentlyContinue
