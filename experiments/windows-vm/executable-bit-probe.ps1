$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\head18.tgz 2>&1 | Out-Null

# The executable bit is the real find here: Windows stores none, so a release verified and repackaged
# on this machine used to lose it and ship a launcher with mode 0644. Now the bit travels IN the
# manifest. This checks the round trip on the machine that cannot hold the bit itself.
$probe = @'
import { readVerifiedSource } from "./scripts/source-manifest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const say = (m: string) => console.log("[s] " + m);

const root = await mkdtemp(join(tmpdir(), "orbit-exe-"));
await mkdir(join(root, "bin"));
const contents: Record<string, string> = {
  "package.json": '{"name":"sbar-orbit","version":"0.1.0-alpha.1"}',
  LICENSE: "L", NOTICE: "N", "bin/sbar-orbit": "#!/bin/sh\nexit 0\n",
};
const files = Object.entries(contents).map(([path, text]) => ({
  path, sha256: createHash("sha256").update(text).digest("hex"), executable: path.startsWith("bin/"),
}));
for (const [path, text] of Object.entries(contents)) await writeFile(join(root, path), text);
await writeFile(join(root, "SOURCE-MANIFEST.json"), JSON.stringify({ version: "0.1.0-alpha.1", files }));

const verified = await readVerifiedSource(root);
const launcher = verified.files.find(f => f.path === "bin/sbar-orbit");
say("launcher executable on a filesystem with no execute bit: " + launcher?.executable);
say("NOTICE executable: " + verified.files.find(f => f.path === "NOTICE")?.executable);

// And the negative: a manifest that does NOT record the bits must be refused here rather than
// repackaged into a release whose launcher cannot run.
const old = await mkdtemp(join(tmpdir(), "orbit-exe-old-"));
await mkdir(join(old, "bin"));
for (const [path, text] of Object.entries(contents)) await writeFile(join(old, path), text);
await writeFile(join(old, "SOURCE-MANIFEST.json"), JSON.stringify({ version: "0.1.0-alpha.1",
  files: files.map(({ path, sha256 }) => ({ path, sha256 })) }));
try { await readVerifiedSource(old); say("a manifest with no bits was ACCEPTED, which would ship mode 0644"); }
catch (error) { say("a manifest with no bits is refused: " + String(error).slice(0, 90)); }
'@
Set-Content -Path C:\orbit\src\exeprobe.ts -Value $probe -Encoding UTF8
Say ((& C:\orbit\bun.exe run C:\orbit\src\exeprobe.ts 2>&1 | Out-String).Trim() -split "`n" | Select-Object -Last 6)
Remove-Item C:\orbit\src\exeprobe.ts -Force -EA SilentlyContinue

Say "=== the suites that needed git, now that it is here ==="
Say ((& C:\orbit\bun.exe test tests/source-manifest.test.ts tests/packaging.test.ts tests/public-audit.test.ts tests/workspace-storage.test.ts 2>&1 | Out-String).Trim() -split "`n" | Select-Object -Last 8)
