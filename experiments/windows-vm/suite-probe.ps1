$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918\sbar-orbit-0.1.0-alpha.6-source'
$env:Path = 'C:\orbit;C:\orbit\git\cmd;' + $env:Path

# The line endings check again, both files, reported per file so a missing one is visible.
foreach ($f in @('install.cmd', 'bin\sbar-orbit.cmd')) {
  $p = Join-Path $Tree $f
  if (-not (Test-Path $p)) { Say "$f : MISSING FROM ARCHIVE"; continue }
  $b = [System.IO.File]::ReadAllBytes($p)
  $crlf = 0; $lf = 0
  for ($i = 0; $i -lt $b.Length; $i++) {
    if ($b[$i] -eq 10) { if ($i -gt 0 -and $b[$i-1] -eq 13) { $crlf++ } else { $lf++ } }
  }
  Say "$f : CRLF=$crlf bareLF=$lf bytes=$($b.Length)"
}

Set-Location $Tree
Say "--- the suite ---"
$out = Join-Path 'C:\orbit' 'suite-0918.log'
& C:\orbit\bun.exe test 2>&1 | Out-File -FilePath $out -Encoding utf8
Say "suite exit: $LASTEXITCODE"

# The counts, read from the log rather than retyped.
$text = Get-Content $out -Raw
foreach ($line in ($text -split "`r?`n")) {
  if ($line -match '^\s*\d+\s+(pass|fail|skip)\s*$') { Say ("count: " + $line.Trim()) }
  if ($line -match '^Ran \d+ tests') { Say $line.Trim() }
}
Say "--- failing test names ---"
foreach ($line in ($text -split "`r?`n")) {
  if ($line -match '^\(fail\)') { Say $line.Trim() }
}
Say "DONE"
