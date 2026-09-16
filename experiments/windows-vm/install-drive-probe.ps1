$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\orbit-inst5.tgz 2>&1 | Out-Null
$prefix = Join-Path $env:LOCALAPPDATA "orbit-install-probe2"
if (Test-Path $prefix) { Remove-Item $prefix -Recurse -Force -EA SilentlyContinue }
$redact = { param($s) $s -replace [regex]::Escape($env:USERPROFILE), "%USERPROFILE%" }

Say "=== install, then drive Orbit THROUGH the installed command ==="
& C:\orbit\src\bin\sbar-orbit.cmd install --json --prefix "$prefix" --no-service 2>&1 | Out-Null
$shim = Join-Path $prefix "bin\sbar-orbit.cmd"
Say ("shim present: " + (Test-Path $shim))

# A broker, started through the INSTALLED command, not the source tree's launcher.
$serve = Start-Process -FilePath $shim -ArgumentList "serve","--managed-socket" -PassThru -WindowStyle Hidden -RedirectStandardOutput C:\orbit\inst-serve.log -RedirectStandardError C:\orbit\inst-serve.err
Say ("serve pid: " + $serve.Id)
Start-Sleep -Seconds 18

Say "=== doctor, through the installed command ==="
$d = & $shim doctor --json 2>&1 | Out-String
try {
  $j = $d | ConvertFrom-Json
  Say ("  platform: " + $j.platform)
  Say ("  browserBackendSupported: " + $j.browserBackendSupported)
  Say ("  sessions: " + $j.sessions)
  Say ("  enforcement: " + $j.resources.limits.enforcement)
  Say ("  browsers: " + (($j.browsers | ForEach-Object { $_.family }) -join ", "))
} catch { Say ("  raw: " + (& $redact $d.Trim()).Substring(0, [Math]::Min(400, $d.Trim().Length))) }

Say "=== status, through the installed command ==="
$s = & $shim status --json 2>&1 | Out-String
Say ("  " + (& $redact $s.Trim()).Substring(0, [Math]::Min(220, $s.Trim().Length)))

Say "=== a real browser session, through the installed command ==="
$c = & $shim session create browser 2>&1 | Out-String
Say ("  create: " + (& $redact $c.Trim()).Substring(0, [Math]::Min(260, $c.Trim().Length)))
try {
  $id = ($c | ConvertFrom-Json).result.sessionId
  $o = & $shim session observe $id 2>&1 | Out-String
  try { $oj = ($o | ConvertFrom-Json).result; Say ("  observe: " + $oj.mimeType + ", " + $oj.width + "x" + $oj.height + ", title=" + $oj.presence.title) }
  catch { Say ("  observe raw: " + $o.Trim().Substring(0, [Math]::Min(220, $o.Trim().Length))) }
  & $shim session stop $id 2>&1 | Out-Null
  Say "  stopped"
} catch { Say "  no session id to drive" }

Stop-Process -Id $serve.Id -Force -EA SilentlyContinue
Get-Process bun, msedge -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Remove-Item $prefix -Recurse -Force -EA SilentlyContinue
Remove-Item C:\orbit\inst-serve.log, C:\orbit\inst-serve.err -Force -EA SilentlyContinue
Say "done"
