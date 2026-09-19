$ErrorActionPreference = 'Continue'
$Root = 'C:\orbit\wz'
if (Test-Path $Root) { Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$env:Path = 'C:\orbit;C:\orbit\git\cmd;' + $env:Path

Push-Location $Root
& tar.exe -xzf C:\orbit\rel-z.tar.gz 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "unpack exit: $LASTEXITCODE"
$Tree = (Get-ChildItem $Root -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1).FullName
if (-not $Tree) { Say "FATAL: no unpacked source tree under $Root"; exit 1 }
Say "tree: $Tree"

foreach ($f in @('install.cmd', 'bin\sbar-orbit.cmd')) {
  $p = Join-Path $Tree $f
  if (-not (Test-Path $p)) { Say "$f : MISSING FROM ARCHIVE"; continue }
  $b = [System.IO.File]::ReadAllBytes($p)
  $crlf = 0; $lf = 0
  for ($i = 0; $i -lt $b.Length; $i++) {
    if ($b[$i] -eq 10) { if ($i -gt 0 -and $b[$i-1] -eq 13) { $crlf++ } else { $lf++ } }
  }
  Say "$f : CRLF=$crlf bareLF=$lf"
}

Set-Location $Tree
& C:\orbit\bun.exe install --frozen-lockfile --ignore-scripts 2>&1 | Select-Object -Last 3 | Out-String | ForEach-Object { Say $_ }
Say "install exit: $LASTEXITCODE"
if (Test-Path (Join-Path $Tree 'website\package.json')) {
  Push-Location (Join-Path $Tree 'website')
  & C:\orbit\bun.exe install 2>&1 | Select-Object -Last 2 | Out-String | ForEach-Object { Say $_ }
  Pop-Location
}
& C:\orbit\bun.exe run typecheck 2>&1 | Select-Object -Last 6 | Out-String | ForEach-Object { Say $_ }
Say "typecheck exit: $LASTEXITCODE"

Say "--- the suite ---"
$out = 'C:\orbit\suite-z.log'
& C:\orbit\bun.exe test 2>&1 | Out-File -FilePath $out -Encoding utf8
Say "suite exit: $LASTEXITCODE"
$text = Get-Content $out -Raw
foreach ($line in ($text -split "`r?`n")) {
  if ($line -match '^\s*\d+\s+(pass|fail|skip)\s*$') { Say ("count: " + $line.Trim()) }
  if ($line -match '^Ran \d+ tests') { Say $line.Trim() }
  if ($line -match '^\(fail\)') { Say ("FAIL: " + $line.Trim()) }
}
Pop-Location
Say "DONE"
