$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"

# The published release, installed and then actually DRIVEN, on a fresh directory with nothing carried
# over. This is the artifact a person downloads, not my working tree.
$fresh = "C:\orbit-release3"
Remove-Item -Recurse -Force $fresh -EA SilentlyContinue
New-Item -ItemType Directory -Path $fresh -Force | Out-Null
& tar.exe -xzf C:\orbit\release3.tar.gz -C $fresh 2>&1 | Out-Null
$root = (Get-ChildItem $fresh -Directory | Select-Object -First 1).FullName
Set-Location $root

Say ("install.cmd bare LF: " + ([regex]::Matches([IO.File]::ReadAllText("$root\install.cmd"), "(?<!`r)`n")).Count)
Say ("launcher bare LF: " + ([regex]::Matches([IO.File]::ReadAllText("$root\bin\sbar-orbit.cmd"), "(?<!`r)`n")).Count)

& C:\orbit\bun.exe install --frozen-lockfile --ignore-scripts 2>&1 | Out-Null
$prefix = Join-Path $env:LOCALAPPDATA "orbit-rel3"
Remove-Item -Recurse -Force $prefix -EA SilentlyContinue

Say "=== the real install ==="
$out = & cmd /c "install.cmd --json --prefix ""$prefix""" 2>&1 | Out-String
Say ("exit: " + $LASTEXITCODE)
$launcher = $null
try {
  $r = $out | ConvertFrom-Json
  Say ("installed=" + $r.installed)
  Say ("steps: " + (($r.steps | ForEach-Object { "$($_.id):$($_.state)" }) -join " "))
  Say ("verify detail: " + ($r.steps | Where-Object { $_.id -eq "verify" }).detail)
  Say ("remedies: " + (($r.remedies | ForEach-Object { $_.id }) -join ", "))
  $launcher = $r.launcher
} catch { Say ("NOT JSON: " + $out.Substring(0,[Math]::Min(400,$out.Length))) }

if ($launcher -and (Test-Path $launcher)) {
  Say "=== a browser session, driven through the INSTALLED command from the release ==="
  Get-Process msedge, bun -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
  $serve = Start-Process -FilePath $launcher -ArgumentList "serve","--managed-socket" `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput C:\orbit\r3.out -RedirectStandardError C:\orbit\r3.err
  $sock = $null
  for ($i=0; $i -lt 90; $i++) {
    Start-Sleep -Milliseconds 500
    $line = Get-Content C:\orbit\r3.out -EA SilentlyContinue | Select-Object -First 1
    if ($line) { try { $sock = ($line | ConvertFrom-Json).socket } catch {} }
    if ($sock) { break }
  }
  Say ("broker socket: " + $(if ($sock) { "bound" } else { "NEVER" }))
  if ($sock) {
    $env:ORBIT_SOCKET = $sock
    $st = & $launcher status --json 2>&1 | Out-String
    Say ("status: " + $st.Trim().Substring(0,[Math]::Min(130,$st.Trim().Length)))
    $made = & $launcher session create browser 2>&1 | Out-String
    $id = $null
    foreach ($m in [regex]::Matches($made, "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) { $id = $m.Value; break }
    Say ("session: " + $(if ($id) { "created " + $id.Substring(0,8) } else { $made.Trim().Substring(0,[Math]::Min(180,$made.Trim().Length)) }))
    if ($id) {
      $seen = & $launcher session observe $id --socket $sock 2>&1 | Out-String
      try {
        $o = $seen.Trim() | ConvertFrom-Json
        Say ("frame: " + $o.mimeType + " " + $o.width + "x" + $o.height)
        [IO.File]::WriteAllBytes("C:\orbit\release-frame.jpg", [Convert]::FromBase64String($o.image))
        Say ("frame bytes: " + (Get-Item C:\orbit\release-frame.jpg).Length)
      } catch { Say ("observe: " + $seen.Trim().Substring(0,[Math]::Min(180,$seen.Trim().Length))) }
      & $launcher session stop $id 2>&1 | Out-Null
      Say "session stopped"
    }
  } else { Say ("stderr: " + ((Get-Content C:\orbit\r3.err -Raw -EA SilentlyContinue) -replace "`r`n"," ")) }
  Stop-Process -Id $serve.Id -Force -EA SilentlyContinue
}
Get-Process msedge, bun -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Say "done"
