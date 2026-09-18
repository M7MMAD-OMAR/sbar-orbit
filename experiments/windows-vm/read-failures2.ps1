$ErrorActionPreference = 'Continue'
$out = 'C:\orbit\suite-0918.log'
$lines = (Get-Content $out -Raw) -split "`r?`n"
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match 'updater may swap') {
    $start = [Math]::Max(0, $i - 30)
    for ($j = $start; $j -le $i; $j++) { $l = $lines[$j].Trim(); if ($l -and $l -notmatch '^\(pass\)' -and $l -notmatch '^\(skip\)') { Say "  | $l" } }
    Say "########"
  }
}
Say "=== now run the CLI by hand, the way the failing test does ==="
$Tree = 'C:\orbit\w0918\sbar-orbit-0.1.0-alpha.6-source'
Set-Location $Tree
$env:ORBIT_CONVERSATION_ID = 'probe-conversation'
& C:\orbit\bun.exe src/cli.ts usage 2>&1 | Out-String | ForEach-Object { Say ("usage stdout+err: " + $_) }
Say "usage exit: $LASTEXITCODE"
& C:\orbit\bun.exe src/cli.ts usage --json 2>&1 | Out-String | ForEach-Object { Say ("usage --json: " + $_) }
Say "usage --json exit: $LASTEXITCODE"
Say "DONE"
