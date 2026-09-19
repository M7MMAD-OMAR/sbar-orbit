# Which Windows autostart mechanism actually brings the broker up in the person's own session.
#
# Windows has no systemd, and docs/windows-measured.md section 1 measured that no Chromium family
# browser runs in session 0 at all. So a Windows Service is the wrong shape, and the real question is
# which per user, interactive session mechanism Orbit should write. Three candidates, measured side
# by side rather than reasoned about:
#
#   1. a Scheduled Task with an AT LOGON trigger
#   2. the HKCU Run key
#   3. a .cmd in the per user Startup folder
#
# This is ROUND ONE: arm all three as the unelevated interactive user, and record what arming each
# one costs. Round two is the reboot. Each mechanism runs the same payload, which writes its own log,
# and the payload is what answers the questions that matter: did it run at all, in which session, did
# a window appear on the person's screen, and did a REAL browser session reach `running` from there
# and return a frame that decodes.
#
# Run it with vmexec_user.py, never vmexec.py. Arming a per user mechanism from SYSTEM in session 0
# arms it for the wrong user and measures nothing about what an installer does.
#
# One thing already measured and worth keeping in view while reading the results: an autostart
# process inherits NO shell PATH. The guest's interactive PATH is
# `C:\WINDOWS\system32;...;%LOCALAPPDATA%\Microsoft\WindowsApps` and nothing else, so a launcher that
# resolved Bun through PATH would fail here exactly the way the macOS LaunchAgent port did. It does
# not, because `bin\sbar-orbit.cmd` resolves Bun by location, and that property is load bearing for
# autostart rather than a nicety.

$Root = 'C:\orbit\autostart-probe'
$Cmd = 'C:\orbit\prefix0918\bin\sbar-orbit.cmd'
if (Test-Path $Root) { Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $Root | Out-Null

$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say "=== round one: arming three mechanisms as $(whoami), sid $sid, elevated: $elevated ==="

# The payload every mechanism runs. One file, so the only difference between three results is the
# mechanism. $Mech says which one started it, and the stagger keeps them from fighting over the
# shared job object budget or over one socket path.
$payload = @'
param([string]$Mech = 'unknown', [int]$DelaySeconds = 0)
$Root = 'C:\orbit\autostart-probe'
$Log = Join-Path $Root ("ran-" + $Mech + ".log")
function Note($m) { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('hh:mm:ss tt') + '  ' + [string]$m) }

Note "started, mechanism: $Mech"
Note ("whoami: " + (whoami))
Note ("session id: " + [System.Diagnostics.Process]::GetCurrentProcess().SessionId)
Note ("interactive: " + [Environment]::UserInteractive)
Note ("seconds since boot: " + [int]((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds)
Note ("inherited PATH: " + $env:Path)

# Does this put a window on the person's screen? That is the project's own rule, so it is measured
# rather than assumed: the console window this process owns, and whether the shell thinks it visible.
# A mechanism that cannot avoid a visible console flashes a black box at the person at every login.
Add-Type -Name W -Namespace P -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
"@
$h = [P.W]::GetConsoleWindow()
Note ("console window handle: " + $h + "  visible: " + $(if ($h -ne [System.IntPtr]::Zero) { [P.W]::IsWindowVisible($h) } else { 'no console' }))

if ($DelaySeconds -gt 0) { Note "waiting $DelaySeconds seconds so the three do not overlap"; Start-Sleep -Seconds $DelaySeconds }

# The half that decides it: a broker, and a REAL browser session through it. A mechanism that runs
# and cannot drive a browser has not solved the problem this project has on Windows. Each mechanism
# gets its own socket, because three brokers racing for one managed socket would measure the race
# rather than the mechanism.
$env:ORBIT_SOCKET = Join-Path $env:LOCALAPPDATA ("sbar-orbit\probe-" + $Mech + ".sock")
if (Test-Path $env:ORBIT_SOCKET) { Remove-Item $env:ORBIT_SOCKET -Force -ErrorAction SilentlyContinue }
$Cmd = 'C:\orbit\prefix0918\bin\sbar-orbit.cmd'
$serve = Start-Process -FilePath $Cmd -ArgumentList 'serve' -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Root "serve-$Mech.out") -RedirectStandardError (Join-Path $Root "serve-$Mech.err")
Note ("broker pid: " + $serve.Id)
$up = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $s = & cmd.exe /c "`"$Cmd`" status --json" 2>&1 | Out-String
  if ($s -match '"sessions"') { Note ("status answered after " + ($i * 2 + 2) + "s: " + ($s -replace "`r?`n",' ')); $up = $true; break }
}
if (-not $up) {
  Note "status NEVER answered"
  Note ("serve stderr: " + (Get-Content (Join-Path $Root "serve-$Mech.err") -Raw -ErrorAction SilentlyContinue))
}

if ($up) {
  $created = & cmd.exe /c "`"$Cmd`" session create browser" 2>&1 | Out-String
  Note ("create: " + ($created -replace "`r?`n",' '))
  $sid2 = $null
  if ($created -match '"sessionId"\s*:\s*"([^"]+)"') { $sid2 = $Matches[1] }
  if ($sid2) {
    $act = '{\"type\":\"navigate\",\"url\":\"https://example.com/\"}'
    & cmd.exe /c "`"$Cmd`" act $sid2 $act" 2>&1 | Out-String | ForEach-Object { Note ("navigate: " + ($_ -replace "`r?`n",' ')) }
    # The page's own text, not a byte count: this is what proves the navigation happened.
    $read = '{\"type\":\"read\",\"selector\":\"h1\"}'
    & cmd.exe /c "`"$Cmd`" act $sid2 $read" 2>&1 | Out-String | ForEach-Object { Note ("read h1: " + ($_ -replace "`r?`n",' ')) }
    & cmd.exe /c "`"$Cmd`" session observe $sid2 --metadata" 2>&1 | Out-String | ForEach-Object { Note ("presence: " + ($_ -replace "`r?`n",' ')) }
    $frame = Join-Path $Root "frame-$Mech.jpg"
    if (Test-Path $frame) { Remove-Item $frame -Force }
    & cmd.exe /c "`"$Cmd`" session observe $sid2 --output $frame" 2>&1 | Out-String | ForEach-Object { Note ("observe: " + ($_ -replace "`r?`n",' ')) }
    if (Test-Path $frame) {
      # A byte count is not a measurement: a blank 6758 byte JPEG passed one on this very guest.
      Add-Type -AssemblyName System.Drawing
      try {
        $img = [System.Drawing.Image]::FromFile($frame)
        Note ("frame: " + (Get-Item $frame).Length + " bytes, decoded " + $img.Width + "x" + $img.Height + " " + $img.RawFormat)
        $img.Dispose()
      } catch { Note ("frame decode FAILED: " + $_.Exception.Message) }
    } else { Note "frame NOT WRITTEN" }
    & cmd.exe /c "`"$Cmd`" session stop $sid2" 2>&1 | Out-String | ForEach-Object { Note ("stop: " + ($_ -replace "`r?`n",' ')) }
  }
}
Stop-Process -Id $serve.Id -Force -ErrorAction SilentlyContinue
Note "___PROBE_DONE___"
'@
Set-Content -LiteralPath (Join-Path $Root 'payload.ps1') -Value $payload -Encoding UTF8

# The Run key and the Startup folder both take a command line and run it through the shell, so each
# gets a one line .cmd. That is also the honest shape: what Orbit would autostart is
# `sbar-orbit.cmd serve`, a batch file.
foreach ($pair in @(,@('runkey', 150)) + @(,@('startup', 320))) {
  $name = $pair[0]; $delay = $pair[1]
  Set-Content -LiteralPath (Join-Path $Root "run-$name.cmd") -Encoding ASCII -Value @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$Root\payload.ps1" -Mech $name -DelaySeconds $delay
"@
}

Say "--- 1a. scheduled task the obvious way: schtasks /SC ONLOGON ---"
$taskAction = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\payload.ps1`" -Mech task -DelaySeconds 5"
& schtasks.exe /Create /TN 'OrbitAutostartProbeOnlogon' /TR $taskAction /SC ONLOGON /F 2>&1 | Out-String | ForEach-Object { Say ("  " + ($_ -replace "`r?`n",' | ')) }
Say ("  /SC ONLOGON exit: " + $LASTEXITCODE)

Say "--- 1b. scheduled task by XML, with the logon trigger SCOPED to this user's SID ---"
# The difference between 1a and 1b is the whole design decision. `/SC ONLOGON` with no user creates a
# trigger for ANY user logging on, which is a machine wide change, so an unelevated caller is refused.
# A LogonTrigger carrying this SID is a change to this one account and is permitted.
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Sbar Orbit local broker, started when you log in</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId><Delay>PT5S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle><UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$Root\payload.ps1" -Mech task -DelaySeconds 5</Arguments></Exec></Actions>
</Task>
"@
$xmlPath = Join-Path $Root 'task.xml'
[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)
& schtasks.exe /Create /TN 'OrbitAutostartProbeTask' /XML $xmlPath /F 2>&1 | Out-String | ForEach-Object { Say ("  " + ($_ -replace "`r?`n",' | ')) }
Say ("  /XML exit: " + $LASTEXITCODE)
& schtasks.exe /Query /TN 'OrbitAutostartProbeTask' /FO LIST 2>&1 | Out-String | ForEach-Object { Say ("  query: " + ($_ -replace "`r?`n",' | ')) }

Say "--- 2. HKCU Run key ---"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-ItemProperty -Path $runKey -Name 'OrbitAutostartProbeRun' -Value ('"' + $Root + '\run-runkey.cmd"') -PropertyType String -Force | Out-Null
Say ("  wrote: " + (Get-ItemProperty -Path $runKey -Name 'OrbitAutostartProbeRun').OrbitAutostartProbeRun)

Say "--- 3. per user Startup folder ---"
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item (Join-Path $Root 'run-startup.cmd') (Join-Path $startup 'OrbitAutostartProbeStartup.cmd') -Force
Say ("  wrote: " + (Join-Path $startup 'OrbitAutostartProbeStartup.cmd') + " exists: " + (Test-Path (Join-Path $startup 'OrbitAutostartProbeStartup.cmd')))

Say "--- what Windows itself calls a startup app, which is where a person turns these off ---"
Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | ForEach-Object { Say ("  " + $_.Location + " :: " + $_.Name + " :: " + $_.Command) }

Say "=== armed. reboot, then read C:\orbit\autostart-probe\ran-*.log ==="
