$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\head21.tgz 2>&1 | Out-Null

# tar does not restore CRLF, and .gitattributes only applies to a git checkout. The file shipped here
# went through tar, so the endings are restored the way a real checkout would have them: otherwise
# this measures the transport rather than the installer.
$raw = [IO.File]::ReadAllText("C:\orbit\src\install.cmd")
[IO.File]::WriteAllText("C:\orbit\src\install.cmd", ($raw -replace "`r`n", "`n" -replace "`n", "`r`n"))
Say ("install.cmd present: " + (Test-Path C:\orbit\src\install.cmd))

$prefix = Join-Path $env:TEMP ("orbit-contract-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Path $prefix -Force | Out-Null

Say "=== the documented plan command, run as an agent would run it ==="
$out = & cmd /c "C:\orbit\src\install.cmd --dry-run --json --prefix ""$prefix""" 2>&1 | Out-String
Say ("exit: " + $LASTEXITCODE)
try {
  $report = $out | ConvertFrom-Json
  Say ("installed: " + $report.installed + "  dryRun: " + $report.dryRun)
  Say ("launcher: " + ($report.launcher -replace [regex]::Escape($env:USERPROFILE), "~"))
  Say ("capabilities: " + (($report.capabilities.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "))
  Say ("steps: " + (($report.steps | ForEach-Object { "$($_.id):$($_.state)" }) -join " "))
  Say ("remedies: " + $report.remedies.Count)
  foreach ($r in $report.remedies) { Say ("   " + $r.id + " agentMayRun=" + $r.agentMayRun + " needsElevation=" + $r.needsElevation) }
} catch {
  Say ("NOT JSON. first 400 chars:")
  Say ($out.Substring(0, [Math]::Min(400, $out.Length)))
}

Say "=== and the contract suite itself ==="
Say ((& C:\orbit\bun.exe test tests/agent-contract.test.ts 2>&1 | Out-String).Trim() -split "`n" | Select-Object -Last 8)

Remove-Item -Recurse -Force $prefix -EA SilentlyContinue
