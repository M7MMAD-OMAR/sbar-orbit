$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\head30.tgz 2>&1 | Out-Null
Get-Process msedge, bun -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 2

# The workflow's own pwsh step, run here before asking GitHub to run it. A workflow that has never
# executed is exactly the "not measured" trap this project is judged on, and the quoting in it is the
# part that took three attempts by hand.
$prefix = Join-Path $env:LOCALAPPDATA "orbit-ci"
Remove-Item -Recurse -Force $prefix -EA SilentlyContinue
Remove-Item -Recurse -Force output\verify -EA SilentlyContinue
New-Item -ItemType Directory -Path output\verify -Force | Out-Null

cmd /c "install.cmd --json --prefix ""$prefix""" | Tee-Object output/verify/install.log | Out-Null
Say ("install exit: " + $LASTEXITCODE)
$launcher = Join-Path $prefix "bin\sbar-orbit.cmd"
Say ("launcher: " + (Test-Path $launcher))

$serve = Start-Process -FilePath $launcher -ArgumentList "serve","--managed-socket" -PassThru -WindowStyle Hidden -RedirectStandardOutput output/verify/serve.out -RedirectStandardError output/verify/serve.err
$socket = $null
for ($i = 0; $i -lt 120 -and -not $socket; $i++) {
  Start-Sleep -Milliseconds 500
  $line = Get-Content output/verify/serve.out -EA SilentlyContinue | Select-Object -First 1
  if ($line) { try { $socket = ($line | ConvertFrom-Json).socket } catch {} }
}
Say ("socket: " + $(if ($socket) { "bound" } else { "NEVER" }))
if (-not $socket) { Say (Get-Content output/verify/serve.err -Raw -EA SilentlyContinue); exit 1 }

$env:ORBIT_SOCKET = $socket
& $launcher status --json | Tee-Object output/verify/status.log | Out-Null
$created = & $launcher session create browser | Tee-Object output/verify/session-create.log | Out-String
$id = ([regex]::Match($created, "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")).Value
Say ("session: " + $(if ($id) { $id.Substring(0,8) } else { "NONE" }))

$action = '{""type"":""navigate"",""url"":""https://example.com/""}'
cmd /c """$launcher"" act $id ""$action""" | Tee-Object output/verify/act.log | Out-Null
Say ("act: " + ((Get-Content output/verify/act.log -Raw) -replace "`r`n"," ").Trim().Substring(0, [Math]::Min(120, ((Get-Content output/verify/act.log -Raw) -replace "`r`n"," ").Trim().Length)))

& $launcher session observe $id --output "$PWD/output/verify/frame.jpg" | Out-Null
& $launcher session observe $id --metadata | Tee-Object output/verify/observe.log | Out-Null
Say ("observe: " + ((Get-Content output/verify/observe.log -Raw) -replace "`r`n"," ").Trim().Substring(0, [Math]::Min(150, ((Get-Content output/verify/observe.log -Raw) -replace "`r`n"," ").Trim().Length)))
& $launcher session stop $id | Out-Null
Stop-Process -Id $serve.Id -Force -EA SilentlyContinue

$bytes = (Get-Item output/verify/frame.jpg -EA SilentlyContinue).Length
Say ("frame bytes: " + $bytes)
Say ("passes the floor the workflow asserts: " + ($bytes -ge 10000))

Get-Process msedge, bun -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Remove-Item -Recurse -Force $prefix -EA SilentlyContinue
Say "done"
