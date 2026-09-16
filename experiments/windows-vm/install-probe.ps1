$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\orbit-inst4.tgz 2>&1 | Out-Null
Say ("unpack exit=" + $LASTEXITCODE)

# The launcher resolves Bun by location, not from the caller's PATH, and this guest keeps bun.exe in
# C:\orbit which is none of those locations. Put it where a real install has it, ~\.bun\bin, so what
# is measured is the install path rather than the probe's own layout.
$bunDir = Join-Path $env:USERPROFILE ".bun\bin"
New-Item -ItemType Directory -Force -Path $bunDir | Out-Null
if (-not (Test-Path (Join-Path $bunDir "bun.exe"))) { Copy-Item C:\orbit\bun.exe (Join-Path $bunDir "bun.exe") -Force }
Say ("bun staged at ~\.bun\bin: " + (Test-Path (Join-Path $bunDir "bun.exe")))

$prefix = Join-Path $env:LOCALAPPDATA "orbit-install-probe"
if (Test-Path $prefix) { Remove-Item $prefix -Recurse -Force -EA SilentlyContinue }
$redact = { param($s) $s -replace [regex]::Escape($env:USERPROFILE), "%USERPROFILE%" }

Say "=== 1. install --dry-run --json, through the .cmd launcher ==="
$dry = & C:\orbit\src\bin\sbar-orbit.cmd install --dry-run --json --prefix "$prefix" --no-service 2>&1 | Out-String
Say (& $redact $dry.Trim())

Say "=== 2. a real install ==="
$real = & C:\orbit\src\bin\sbar-orbit.cmd install --json --prefix "$prefix" --no-service 2>&1 | Out-String
Say (& $redact $real.Trim())

Say "=== 3. what landed in the prefix ==="
Get-ChildItem (Join-Path $prefix "bin") -EA SilentlyContinue | ForEach-Object { Say ("  " + $_.Name + "  " + $_.Length + " bytes") }
$shim = Join-Path $prefix "bin\sbar-orbit.cmd"
if (Test-Path $shim) {
  Say "shim contents:"
  Get-Content $shim | ForEach-Object { Say ("  | " + (& $redact $_)) }
}

Say "=== 4. does the installed command actually run Orbit? ==="
$v = & $shim --version 2>&1 | Out-String
Say ("  --version: " + (& $redact $v.Trim()))
$d = & $shim doctor --json 2>&1 | Out-String
try {
  $j = $d | ConvertFrom-Json
  Say ("  doctor platform: " + $j.platform + ", browserBackendSupported: " + $j.browserBackendSupported)
} catch { Say ("  doctor raw: " + (& $redact $d.Trim()).Substring(0, [Math]::Min(300, $d.Trim().Length))) }

Say "=== 5. installing twice must be safe, and must not duplicate ==="
$again = & C:\orbit\src\bin\sbar-orbit.cmd install --json --prefix "$prefix" --no-service 2>&1 | Out-String
try { $j2 = $again | ConvertFrom-Json; Say ("  second install ok: " + $j2.ok) } catch { Say ("  second install: " + (& $redact $again.Trim()).Substring(0, [Math]::Min(250, $again.Trim().Length))) }

Say "=== 6. it must refuse to overwrite a file that is not ours ==="
$foreign = Join-Path $prefix "bin\sbar-orbit.cmd"
Set-Content -Path $foreign -Value "@echo off`r`necho this is someone else's batch file`r`n" -Encoding ASCII
$refuse = & C:\orbit\src\bin\sbar-orbit.cmd install --json --prefix "$prefix" --no-service 2>&1 | Out-String
Say ("  " + (& $redact $refuse.Trim()).Substring(0, [Math]::Min(320, $refuse.Trim().Length)))
Say ("  foreign file still intact: " + ((Get-Content $foreign -Raw) -match "someone else"))

Remove-Item $prefix -Recurse -Force -EA SilentlyContinue
Say "done"
