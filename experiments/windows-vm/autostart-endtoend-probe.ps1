# Round two of the autostart measurement: the real install path, then a reboot.
#
# `autostart-probe.ps1` armed three candidate mechanisms and a reboot chose between them. This one
# is the product: `install.cmd --json` with NO `--no-service`, which is the command that has never
# been run on Windows because the service step used to refuse there. It registers the logon task
# through `src/windows-autostart.ts`, and then the guest is rebooted and the chain is checked with no
# human action: broker listening, `status` answering, a browser session reaching `running`, and a
# frame whose CONTENT names the page.
#
# Run with vmexec_user.py. Session 0 cannot install a per user task for the right user, and cannot
# run a browser at all.
#
# ORBIT_CAPTURE_TIMEOUT_MS is set into the task's own environment, at 20000 rather than the 3000 ms
# default, because the first capture here happens seconds after a cold boot and a logon: a frame that
# times out on a cold machine would look like autostart failing when it is only capture timing out.

# vmexec_user.py wraps this script in a logging preamble, so a `param()` block cannot be first and is
# not used. The arming half runs unconditionally; `verify.ps1`, which this writes, is the half that
# runs after the reboot.

$Tree = 'C:\orbit\wfin\sbar-orbit-0.1.0-alpha.7-source'
$Prefix = 'C:\orbit\prefix-autostart'
$Evidence = 'C:\orbit\autostart-evidence'
$env:Path = "$env:USERPROFILE\.bun\bin;" + $env:Path

if ($true) {
  Say "=== ARM: install with the service step ENABLED, which Windows has never done before ==="
  if (Test-Path $Evidence) { Remove-Item -Recurse -Force $Evidence -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
  if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix -ErrorAction SilentlyContinue }

  Set-Location $Tree
  Say ("elevated: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  Say ("whoami: " + (whoami) + "  session: " + [System.Diagnostics.Process]::GetCurrentProcess().SessionId)

  # Start from nothing of ours, so what is measured is this install rather than a leftover.
  & schtasks.exe /Delete /TN 'SbarOrbitBroker' /F 2>&1 | Out-Null

  $out = & cmd.exe /c "install.cmd --json --prefix $Prefix" 2>&1 | Out-String
  Say ("install exit: " + $LASTEXITCODE)
  Set-Content -LiteralPath (Join-Path $Evidence 'install.json') -Value $out
  Say ("install json: " + ($out -replace "`r?`n",' '))

  Say "--- what the install registered, read back out of Task Scheduler rather than out of the report ---"
  & schtasks.exe /Query /TN 'SbarOrbitBroker' /FO LIST /V 2>&1 | Out-String | ForEach-Object { Say ($_ -replace "`r?`n",' | ') }
  $xmlBack = & schtasks.exe /Query /TN 'SbarOrbitBroker' /XML 2>&1 | Out-String
  Set-Content -LiteralPath (Join-Path $Evidence 'task.xml') -Value $xmlBack
  Say ("registered XML carries the marker: " + ($xmlBack -match 'Sbar Orbit local broker'))
  Say ("registered XML carries InteractiveToken: " + ($xmlBack -match 'InteractiveToken'))
  Say ("registered XML carries this SID: " + ($xmlBack -match ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value))

  Say "--- the CLI status surface, the way a person would ask ---"
  & cmd.exe /c "`"$Prefix\bin\sbar-orbit.cmd`" autostart status" 2>&1 | Out-String | ForEach-Object { Say ("autostart status: " + ($_ -replace "`r?`n",' ')) }

  # The capture budget into the task's environment, because a task inherits no shell profile. Done by
  # re-registering through the product's own enable with an environment, which is the shape that
  # ships rather than a hand edit of the XML.
  Say "--- re-register with a capture budget the cold first frame can meet ---"
  $script = @"
import { enableLogonTask } from './src/windows-autostart';
const task = await enableLogonTask(String.raw``$Prefix\bin\sbar-orbit.cmd``, { environment: { ORBIT_CAPTURE_TIMEOUT_MS: '20000' } });
console.log(JSON.stringify({ registered: task.registered, status: task.status }));
"@
  Set-Content -LiteralPath (Join-Path $Tree 'arm-autostart.ts') -Value $script -Encoding UTF8
  & bun.exe run arm-autostart.ts 2>&1 | Out-String | ForEach-Object { Say ("re-register: " + ($_ -replace "`r?`n",' ')) }
  $xml2 = & schtasks.exe /Query /TN 'SbarOrbitBroker' /XML 2>&1 | Out-String
  Say ("capture budget is in the registered action: " + ($xml2 -match 'ORBIT_CAPTURE_TIMEOUT_MS=20000'))

  # The proof that survives the reboot. The task starts the broker; this is what will read it.
  $verify = @'
$Evidence = 'C:\orbit\autostart-evidence'
$Log = Join-Path $Evidence 'after-logon.log'
function Note($m) { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('hh:mm:ss tt') + '  ' + [string]$m) }
$Cmd = 'C:\orbit\prefix-autostart\bin\sbar-orbit.cmd'

Note "=== after logon, with NO human action beyond the logon itself ==="
Note ("seconds since boot: " + [int]((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds)
Note ("this reader is in session: " + [System.Diagnostics.Process]::GetCurrentProcess().SessionId)
Note ("task last run: " + ((& schtasks.exe /Query /TN 'SbarOrbitBroker' /FO LIST /V 2>&1 | Out-String) -replace "`r?`n",' | '))

# The broker the TASK started, not one this script starts. Nothing here runs `serve`.
$broker = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -match 'serve' }
foreach ($b in $broker) { Note ("broker process: pid " + $b.ProcessId + " session " + $b.SessionId + " :: " + $b.CommandLine) }
if (-not $broker) { Note "NO BROKER PROCESS: the task did not leave one running" }

$sock = Join-Path $env:LOCALAPPDATA 'sbar-orbit\broker.sock'
Note ("managed socket present: " + (Test-Path $sock))

$up = $false
for ($i = 0; $i -lt 30; $i++) {
  $s = & cmd.exe /c "`"$Cmd`" status --json" 2>&1 | Out-String
  if ($s -match '"sessions"') { Note ("status answered " + ($i * 3) + "s into this check: " + ($s -replace "`r?`n",' ')); $up = $true; break }
  Start-Sleep -Seconds 3
}
if (-not $up) { Note "status NEVER answered, so the autostarted broker is not usable" }

if ($up) {
  $created = & cmd.exe /c "`"$Cmd`" session create browser" 2>&1 | Out-String
  Note ("create: " + ($created -replace "`r?`n",' '))
  $sid = $null
  if ($created -match '"sessionId"\s*:\s*"([^"]+)"') { $sid = $Matches[1] }
  if ($sid) {
    # The FILE form of act. A JSON document on a PowerShell command line does not survive the quoting,
    # measured on a GitHub windows-latest runner as `CLI_ERROR: JSON Parse error: Unterminated string`.
    $navFile = Join-Path $Evidence 'nav.json'
    Set-Content -LiteralPath $navFile -Value '{"type":"navigate","url":"https://example.com/"}' -Encoding ASCII
    & cmd.exe /c "`"$Cmd`" act $sid @$navFile" 2>&1 | Out-String | ForEach-Object { Note ("navigate: " + ($_ -replace "`r?`n",' ')) }
    $readFile = Join-Path $Evidence 'read.json'
    Set-Content -LiteralPath $readFile -Value '{"type":"read","selector":"h1"}' -Encoding ASCII
    # The page's own text. This is what proves the navigation happened, rather than a byte count.
    & cmd.exe /c "`"$Cmd`" act $sid @$readFile" 2>&1 | Out-String | ForEach-Object { Note ("read h1: " + ($_ -replace "`r?`n",' ')) }
    & cmd.exe /c "`"$Cmd`" session observe $sid --metadata" 2>&1 | Out-String | ForEach-Object { Note ("presence: " + ($_ -replace "`r?`n",' ')) }
    $frame = Join-Path $Evidence 'after-logon-frame.jpg'
    if (Test-Path $frame) { Remove-Item $frame -Force }
    & cmd.exe /c "`"$Cmd`" session observe $sid --output $frame" 2>&1 | Out-String | ForEach-Object { Note ("observe: " + ($_ -replace "`r?`n",' ')) }
    if (Test-Path $frame) {
      Add-Type -AssemblyName System.Drawing
      try {
        $img = [System.Drawing.Image]::FromFile($frame)
        Note ("frame: " + (Get-Item $frame).Length + " bytes, decoded " + $img.Width + "x" + $img.Height + " " + $img.RawFormat)
        $img.Dispose()
      } catch { Note ("frame decode FAILED: " + $_.Exception.Message) }
    } else { Note "frame NOT WRITTEN" }
    & cmd.exe /c "`"$Cmd`" session stop $sid" 2>&1 | Out-String | ForEach-Object { Note ("stop: " + ($_ -replace "`r?`n",' ')) }
  }
}
Note "___VERIFY_DONE___"
'@
  Set-Content -LiteralPath (Join-Path $Evidence 'verify.ps1') -Value $verify -Encoding UTF8
  Say "=== armed. reboot, log on, then run C:\orbit\autostart-evidence\verify.ps1 ==="
}
