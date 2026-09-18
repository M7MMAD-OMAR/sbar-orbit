$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918d\sbar-orbit-0.1.0-alpha.6-source'
$Prefix = 'C:\orbit\prefix0918'
$env:Path = 'C:\orbit;' + $env:Path
if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix -ErrorAction SilentlyContinue }

Set-Location $Tree

Say "=== 1. the documented install, exactly as docs/agent-install.md tells an agent to run it ==="
& cmd.exe /c "install.cmd --dry-run --json --prefix $Prefix --no-service" 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "dry run exit: $LASTEXITCODE"
& cmd.exe /c "install.cmd --json --prefix $Prefix --no-service" 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "install exit: $LASTEXITCODE"

$Cmd = Join-Path $Prefix 'bin\sbar-orbit.cmd'
Say "installed command present: $(Test-Path $Cmd)"

Say "=== 2. the connector file, where Windows keeps configuration, and its ACL ==="
$Connector = Join-Path $env:APPDATA 'sbar-orbit\mcp.json'
Say "connector at: $Connector  exists: $(Test-Path $Connector)"
if (Test-Path $Connector) {
  Say ("contents: " + ((Get-Content $Connector -Raw) -replace "`r?`n", " "))
  $acl = Get-Acl -LiteralPath $Connector
  foreach ($a in $acl.Access) { Say ("  ACE: " + $a.IdentityReference + " " + $a.FileSystemRights) }
  $exposed = $acl.Access | Where-Object { $_.IdentityReference -match 'Everyone|ANONYMOUS|\\Users$|Authenticated Users|Guests|INTERACTIVE' }
  Say ("exposed principals: " + $(if ($exposed) { ($exposed | ForEach-Object { $_.IdentityReference }) -join ',' } else { 'NONE' }))
}

Say "=== 3. a broker, and a real browser session through the INSTALLED command ==="
$serve = Start-Process -FilePath $Cmd -ArgumentList 'serve --managed-socket' -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput 'C:\orbit\serve0918.out' -RedirectStandardError 'C:\orbit\serve0918.err'
Say "broker pid: $($serve.Id)"
Start-Sleep -Seconds 8

& cmd.exe /c "`"$Cmd`" status --json" 2>&1 | Out-String | ForEach-Object { Say ("status: " + $_) }

$created = & cmd.exe /c "`"$Cmd`" session create browser" 2>&1 | Out-String
Say ("create: " + $created)
$sid = $null
if ($created -match '"sessionId"\s*:\s*"([^"]+)"') { $sid = $Matches[1] }
Say "session id: $sid"

if ($sid) {
  $act = '{\"type\":\"navigate\",\"url\":\"https://example.com/\"}'
  & cmd.exe /c "`"$Cmd`" act $sid $act" 2>&1 | Out-String | ForEach-Object { Say ("navigate: " + $_) }
  $frame = 'C:\orbit\frame0918.jpg'
  if (Test-Path $frame) { Remove-Item $frame -Force }
  & cmd.exe /c "`"$Cmd`" session observe $sid --output $frame" 2>&1 | Out-String | ForEach-Object { Say ("observe: " + $_) }
  if (Test-Path $frame) {
    $bytes = (Get-Item $frame).Length
    Say "frame bytes: $bytes"
    # A byte count is not a measurement: a blank 6758 byte JPEG passed one before. Decode it.
    Add-Type -AssemblyName System.Drawing
    try {
      $img = [System.Drawing.Image]::FromFile($frame)
      Say "frame decoded: $($img.Width)x$($img.Height) $($img.RawFormat)"
      $img.Dispose()
    } catch { Say "frame decode FAILED: $($_.Exception.Message)" }
  } else { Say "frame: NOT WRITTEN" }

  Say "=== 4. browser processes belong to Orbit's own profile, and are reaped ==="
  $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'"
  Say ("browser processes while the session is open: " + ($procs | Measure-Object).Count)
  & cmd.exe /c "`"$Cmd`" session stop $sid" 2>&1 | Out-String | ForEach-Object { Say ("stop: " + $_) }
  Start-Sleep -Seconds 4
  $after = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'"
  Say ("browser processes after stop: " + ($after | Measure-Object).Count)
}

Say "=== 5. the journal's ACL, which is where a person's data would leak ==="
$journal = Join-Path $env:LOCALAPPDATA 'sbar-orbit\diagnostics\events.jsonl'
Say "journal at: $journal  exists: $(Test-Path $journal)"
if (Test-Path $journal) {
  $acl = Get-Acl -LiteralPath $journal
  foreach ($a in $acl.Access) { Say ("  ACE: " + $a.IdentityReference + " " + $a.FileSystemRights) }
  $exposed = $acl.Access | Where-Object { $_.IdentityReference -match 'Everyone|ANONYMOUS|\\Users$|Authenticated Users|Guests|INTERACTIVE' }
  Say ("exposed principals: " + $(if ($exposed) { ($exposed | ForEach-Object { $_.IdentityReference }) -join ',' } else { 'NONE' }))
  Say ("journal carries a params field (it must not): " + ((Get-Content $journal -Raw) -match '"params"'))
}

Say "=== 6. the broker dying does not leave a browser behind ==="
Say "stopping broker with taskkill /F, which runs no cleanup handler"
& taskkill.exe /PID $serve.Id /T /F 2>&1 | Out-String | ForEach-Object { Say $_ }
Start-Sleep -Seconds 5
$survivors = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'"
Say ("browser survivors after broker death: " + ($survivors | Measure-Object).Count)

Say "DONE"
