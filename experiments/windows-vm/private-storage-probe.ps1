$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\head11.tgz 2>&1 | Out-Null
Say ("unpack exit=" + $LASTEXITCODE)

# Two suites fail on the guest asserting mode 0o600 (384) and getting 438, which reads as "a POSIX
# file mode test". The SUBJECT underneath is not the mode: it is that the files carrying a person's
# private data stay private. Windows ignores the mode argument entirely, so that property has never
# been checked here at all, and the failing assertion was standing in for it.
#
# This writes the real files through the real product code, then asks Windows who can actually read
# them, and separately checks the secret redaction that the same suite was supposed to prove.
$probe = @'
import { Diagnostics } from "./src/diagnostics";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const say = (m: string) => console.log("[s] " + m.replace(process.env.USERPROFILE ?? "@@", "~"));

const root = mkdtempSync(join(tmpdir(), "orbit-priv-"));
const diagnostics = new Diagnostics(root);

// A failure carrying something that must never reach disk in the clear.
await diagnostics.run({ method: "session.act", params: { sessionId: "s1" } }, async () => {
  throw new Error("boom: password=hunter2 token=ghp_SECRETVALUE cookie=sid=abc123");
}).catch(() => {});
await diagnostics.run({ method: "doctor", params: {} }, async () => ({ ok: true }));

const { readdirSync, readFileSync } = await import("node:fs");
const files = readdirSync(root);
say("diagnostics files: " + files.join(", "));

// 1. Does the redaction hold? This is the half the mode assertion was hiding.
let text = "";
for (const name of files) { try { text += readFileSync(join(root, name), "utf8"); } catch {} }
for (const secret of ["hunter2", "ghp_SECRETVALUE", "sid=abc123"]) {
  say(`secret ${secret} on disk: ${text.includes(secret) ? "LEAKED" : "absent"}`);
}
say("the failure itself is still recorded: " + (text.includes("boom") ? "yes" : "NO, which would be worse"));

// 2. Who can actually read these files, according to Windows rather than according to a mode?
const acl = (path: string) => {
  const out = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
    `(Get-Acl -LiteralPath '${path}').Access | ForEach-Object { "$($_.IdentityReference)=$($_.FileSystemRights)" }`]);
  return out.stdout.toString().trim().split(/\r?\n/).filter(Boolean);
};
const target = files.length ? join(root, files[0]!) : root;
say("ACL on " + (files.length ? files[0] : "the directory") + ":");
for (const entry of acl(target)) say("   " + entry.replace(process.env.USERNAME ?? "@@", "<user>"));

// 3. The question that actually matters: can anything outside SYSTEM, Administrators and the owner
//    read it? Those three are the same set the socket file inherits, measured in section 2.
const dangerous = acl(target).filter(entry =>
  /Everyone|ANONYMOUS|Users=|BUILTIN\\Users|INTERACTIVE|Authenticated/i.test(entry));
say("principals beyond SYSTEM/Administrators/owner: " + (dangerous.length ? dangerous.join(" | ") : "none"));
say("done");
'@
Set-Content -Path C:\orbit\src\privprobe.ts -Value $probe -Encoding UTF8
Say ((& C:\orbit\bun.exe run C:\orbit\src\privprobe.ts 2>&1 | Out-String).Trim())
Remove-Item C:\orbit\src\privprobe.ts -Force -EA SilentlyContinue
