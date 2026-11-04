param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
try {
  $canonicalRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not [IO.Path]::IsPathRooted($Root) -or $canonicalRoot -ne $Root) { throw 'Noncanonical managed root' }
  $launcher = Join-Path $canonicalRoot 'bin/Orbit.exe'
  $json = (& $launcher --prepare-uninstall $canonicalRoot | Out-String)
  if ($LASTEXITCODE -ne 0 -or $json.Length -gt 65536) { throw 'Managed maintenance preparation refused' }
  $maintenance = $json | ConvertFrom-Json
  if ($maintenance.ok -ne $true) { throw 'Managed maintenance preparation failed' }
  foreach ($path in @($maintenance.runtime, $maintenance.entry)) {
    if ($path -isnot [string] -or -not [IO.Path]::IsPathRooted($path) -or [IO.Path]::GetFullPath($path) -ne $path -or $path.StartsWith($canonicalRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Maintenance must execute outside the managed installation' }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Redirected maintenance executable refused' }
  }
  # The stable launcher has exited. Only the verified external maintenance copy owns removals/tasks.
  & $maintenance.runtime $maintenance.entry uninstall --root $canonicalRoot
  exit $LASTEXITCODE
} catch {
  Write-Error 'Safe managed removal was refused. No installer-owned pointer/task deletion was attempted.'
  exit 2
}
