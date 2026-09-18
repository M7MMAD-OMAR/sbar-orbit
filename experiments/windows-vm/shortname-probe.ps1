$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918\sbar-orbit-0.1.0-alpha.6-source'
Set-Location $Tree

# Does realpath expand an 8.3 SHORT path on Windows, or only resolve symlinks? The install fixtures
# now lean on `resolvedTmpdir()` = realpath(tmpdir()) to make the fixture and the product agree, and
# that only works if realpath expands. Asked of the running kernel rather than assumed.
$probe = @'
import { realpath, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
const t = tmpdir();
console.log("tmpdir():        " + t);
console.log("realpathSync:    " + realpathSync(t));
console.log("realpathSync.nat:" + realpathSync.native(t));
console.log("USERPROFILE:     " + process.env.USERPROFILE);
console.log("LOCALAPPDATA:    " + process.env.LOCALAPPDATA);
console.log("TEMP:            " + process.env.TEMP);
'@
Set-Content -Path 'C:\orbit\rp.mjs' -Value $probe -Encoding utf8
& C:\orbit\bun.exe C:\orbit\rp.mjs 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "DONE"
