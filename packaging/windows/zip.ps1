param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd([IO.Path]::DirectorySeparatorChar)
$outputPath = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $outputPath) { throw 'Archive already exists' }
$items = @(Get-ChildItem -LiteralPath $sourcePath -Recurse -Force)
foreach ($item in $items) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected packaging input refused' }
}
$archive = [IO.Compression.ZipFile]::Open($outputPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in @($items | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName)) {
    $relative = $file.FullName.Substring($sourcePath.Length + 1).Replace('\','/')
    if ($relative.Contains('..') -or $relative.Contains(':') -or $relative.StartsWith('/')) { throw 'Invalid packaging path' }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose() }
