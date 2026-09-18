$ErrorActionPreference = 'Continue'
# A clean room: nothing carried over from any earlier run in C:\orbit\src.
$Root = 'C:\orbit\w0918'
if (Test-Path $Root) { Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$env:Path = 'C:\orbit;C:\orbit\git\cmd;' + $env:Path

Say "root: $Root"
Push-Location $Root
# Windows 10 1809 and later ship bsdtar as tar.exe in System32, which is what a person unpacking a
# release would actually use.
& tar.exe -xzf C:\orbit\rel-0918.tar.gz 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "unpack exit: $LASTEXITCODE"
$Tree = Join-Path $Root 'sbar-orbit-0.1.0-alpha.6-source'
Say "tree exists: $(Test-Path $Tree)"

# Line endings in the shipped batch files, read as bytes rather than inferred.
foreach ($f in @('install.cmd','bin\sbar-orbit.cmd')) {
  $p = Join-Path $Tree $f
  if (Test-Path $p) {
    $b = [System.IO.File]::ReadAllBytes($p)
    $crlf = 0; $lf = 0
    for ($i = 0; $i -lt $b.Length; $i++) {
      if ($b[$i] -eq 10) { if ($i -gt 0 -and $b[$i-1] -eq 13) { $crlf++ } else { $lf++ } }
    }
    Say "$f  CRLF=$crlf bareLF=$lf"
  } else { Say "$f MISSING" }
}

Set-Location $Tree
Say "--- bun install ---"
& C:\orbit\bun.exe install --frozen-lockfile --ignore-scripts 2>&1 | Select-Object -Last 8 | Out-String | ForEach-Object { Say $_ }
Say "install exit: $LASTEXITCODE"

Say "--- website workspace ---"
if (Test-Path (Join-Path $Tree 'website\package.json')) {
  Push-Location (Join-Path $Tree 'website')
  & C:\orbit\bun.exe install 2>&1 | Select-Object -Last 4 | Out-String | ForEach-Object { Say $_ }
  Say "website install exit: $LASTEXITCODE"
  Pop-Location
} else { Say "no website workspace in the archive" }

Say "--- typecheck ---"
& C:\orbit\bun.exe run typecheck 2>&1 | Select-Object -Last 20 | Out-String | ForEach-Object { Say $_ }
Say "typecheck exit: $LASTEXITCODE"

Say "--- versions ---"
Say ("bun " + (& C:\orbit\bun.exe --version))
Say ("git " + (& C:\orbit\git\cmd\git.exe --version))
Pop-Location
Say "DONE"
