$ErrorActionPreference = 'Continue'

# The library dimension, measured on the guest rather than reasoned about on Linux.
#
# The install path everywhere passes --ignore-scripts, and playwright normally downloads its browser
# binaries in a postinstall. So the questions this probe answers are: did that download actually get
# skipped on Windows, does the project work anyway, and is the browser it drives the one Windows
# already had rather than one playwright fetched.

# The archive unpacks into a NAMED directory inside the unpack root, so the tree is one level deeper
# than the root the other probes use. Pointing at the root instead printed "node_modules=none" and
# "top-level packages: 0" for a tree that was fully installed, which reads as a finding rather than as
# a wrong path. Resolve it rather than hardcoding the version.
$unpackRoot = 'C:\orbit\w0918i'
$root = (Get-ChildItem $unpackRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1).FullName
if (-not $root) { Write-Output "FATAL: no unpacked source tree under $unpackRoot"; exit 1 }
Write-Output "tree: $root"
Set-Location $root

Write-Output '--- 1. did playwright download any browser at install time ---'
$cache = Join-Path $env:LOCALAPPDATA 'ms-playwright'
if (Test-Path $cache) {
  $items = Get-ChildItem $cache -ErrorAction SilentlyContinue
  Write-Output "ms-playwright cache EXISTS with $($items.Count) entries"
  $items | ForEach-Object { Write-Output "  entry: $($_.Name)" }
} else {
  Write-Output 'ms-playwright cache: ABSENT (no browser was downloaded, as intended)'
}

Write-Output '--- 2. size of what --ignore-scripts saved us ---'
$pw = Join-Path $root 'node_modules\playwright'
if (Test-Path $pw) {
  $bytes = (Get-ChildItem $pw -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum
  Write-Output "node_modules\playwright on disk: $([math]::Round($bytes/1MB,2)) MB"
}
$pwc = Join-Path $root 'node_modules\playwright-core'
if (Test-Path $pwc) {
  $bytes = (Get-ChildItem $pwc -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum
  Write-Output "node_modules\playwright-core on disk: $([math]::Round($bytes/1MB,2)) MB"
}

Write-Output '--- 3. do the three runtime deps resolve at all on this host ---'
$resolve = @'
for (const name of ["playwright", "zod", "@modelcontextprotocol/sdk/client/index.js"]) {
  try { console.log("resolved", name, "->", Bun.resolveSync(name, process.cwd()).length, "chars"); }
  catch (error) { console.log("FAILED", name, String(error)); }
}
// The one value import the project makes from playwright. If the postinstall mattered, this throws.
const { chromium } = await import("playwright");
console.log("chromium import:", typeof chromium, "connectOverCDP:", typeof chromium.connectOverCDP);
// And the browser it will actually drive: a real Windows install, not a downloaded one.
try {
  console.log("playwright would use:", chromium.executablePath());
} catch (error) {
  console.log("chromium.executablePath() threw, which is EXPECTED with no download:", String(error).slice(0, 120));
}
'@
Set-Content -Path 'C:\orbit\resolve-probe.mjs' -Value $resolve -Encoding UTF8
& C:\orbit\bun.exe run C:\orbit\resolve-probe.mjs 2>&1 | ForEach-Object { Write-Output $_ }

Write-Output '--- 4. which browser does ORBIT itself pick on this host ---'
& C:\orbit\bun.exe run bin/sbar-orbit.cmd --help 2>&1 | Select-Object -First 3 | ForEach-Object { Write-Output $_ }
$probe = @'
const { detectWindowsBrowsers } = await import("./src/runtime-paths.ts").catch(() => ({}));
const paths = await import("./src/runtime-paths.ts");
const names = Object.keys(paths);
console.log("runtime-paths exports:", names.join(", "));
'@
Set-Content -Path (Join-Path $root 'browser-pick.mjs') -Value $probe -Encoding UTF8
& C:\orbit\bun.exe run (Join-Path $root 'browser-pick.mjs') 2>&1 | Select-Object -First 6 | ForEach-Object { Write-Output $_ }

Write-Output '--- 5. any native .node binary that cannot work on win32 ---'
$native = Get-ChildItem (Join-Path $root 'node_modules') -Recurse -Filter '*.node' -ErrorAction SilentlyContinue
Write-Output "native .node files found: $($native.Count)"
$native | Select-Object -First 10 | ForEach-Object { Write-Output "  $($_.FullName.Replace($root,''))" }

Write-Output '--- 6. package count actually installed here ---'
$pkgs = (Get-ChildItem (Join-Path $root 'node_modules') -Directory -ErrorAction SilentlyContinue).Count
Write-Output "top-level node_modules entries: $pkgs"

Write-Output 'DONE'
