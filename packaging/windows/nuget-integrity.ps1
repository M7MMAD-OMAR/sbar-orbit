param([ValidateSet('Prepare','Run','Diagnose')][string]$Phase)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $IsWindows) { throw 'Dedicated hosted Windows diagnostic only' }
if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$') { throw 'Owned run identity missing' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root = Join-Path $env:RUNNER_TEMP ('orbit-nuget-integrity-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT)
$evidence = Join-Path $root 'evidence'
$project = Join-Path $root 'fixture'
$bun = Join-Path $root 'bun.exe'
$reportPath = Join-Path $evidence 'diagnostic.build.json'
$expected = 'cOaiVqP3BmQHMnxGpZzANM22tUXgycrisyJHjIGNzIaMsm8iXj7Kx+ceYg+RbYwJtzT009qfcFTocvVLY+ekMw=='
$pins = Get-Content (Join-Path $repo 'desktop/windows/build-pins.json') -Raw | ConvertFrom-Json
if ($pins.bun.version -ne '1.4.4' -or $pins.bun.sha256 -ne 'cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5' -or
    $pins.bun.url -ne 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64.zip' -or
    $pins.dotnetSdk -ne '10.0.403' -or $pins.webView2.version -ne '1.0.4314.35' -or $pins.webView2.sha512 -cne $expected) { throw 'Diagnostic pins changed; review a new diagnostic explicitly' }
function Write-Json($Path, $Value) { [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) }
function Check-Reserve { & (Join-Path $PSScriptRoot 'preflight.ps1'); if (([IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))).AvailableFreeSpace -lt 4GB) { throw 'Hosted diagnostic disk reserve unavailable' } }
function Sha512-Base64([string]$Path) {
  if ((Get-Item -LiteralPath $Path).Length -gt 128MB) { throw 'Package exceeds diagnostic bound' }
  return [Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($Path)))
}
if ($Phase -eq 'Prepare') {
  Check-Reserve
  New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
  New-Item -ItemType Directory -Path $evidence,$project | Out-Null
  Write-Json $reportPath @{schema=1;status='preparing';publicationReadiness=$false;metadataOnly=$true;runtimePayloadUploaded=$false}
  $archive = Join-Path $root 'bun-runtime.zip'
  Invoke-WebRequest -Uri $pins.bun.url -OutFile $archive -TimeoutSec 180
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pins.bun.sha256) { throw 'Official Bun ZIP digest differs' }
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $member = $zip.GetEntry('bun-windows-x64/bun.exe')
    if (-not $member -or $member.Length -lt 1 -or $member.Length -gt 256MB) { throw 'Pinned Bun member/layout exceeds bound' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($member, $bun, $false)
  } finally { $zip.Dispose() }
  Copy-Item -LiteralPath (Join-Path $repo 'desktop/windows/global.json') -Destination (Join-Path $project 'global.json')
  Write-Json $reportPath @{schema=1;status='prepared';publicationReadiness=$false;metadataOnly=$true;runtimePayloadUploaded=$false;bunVersion=$pins.bun.version;bunArchiveSha256=$pins.bun.sha256;bunExeSha256=(Get-FileHash -LiteralPath $bun -Algorithm SHA256).Hash.ToLowerInvariant();bunExeBytes=(Get-Item -LiteralPath $bun).Length}
  return
}
if ($Phase -eq 'Run') {
  Check-Reserve
  if (-not (Test-Path -LiteralPath $bun -PathType Leaf)) { throw 'Prepared runtime missing' }
  & $bun (Join-Path $repo 'scripts/limited.ts') (Get-Command pwsh -CommandType Application).Source '-NoProfile' '-NonInteractive' '-File' $PSCommandPath '-Phase' 'Diagnose'
  if ($LASTEXITCODE) { throw "Budgeted NuGet diagnostic failed: $LASTEXITCODE" }
  return
}
# All Diagnose descendants run inside the Windows Job Object established by limited.ts.
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json -AsHashtable
$report.status = 'running'
$report.productionLockChanged = $false
$report.sourceCommit = (& git -C $repo rev-parse HEAD).Trim()
$env:DOTNET_CLI_HOME = Join-Path $root 'dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_CLI_UI_LANGUAGE = 'en-US'
$env:DOTNET_PROCESSOR_COUNT = '2'
$env:NUGET_HTTP_CACHE_PATH = Join-Path $root 'http-first'
$env:NUGET_PACKAGES = Join-Path $root 'cache-first'
$env:NUGET_PLUGINS_CACHE_PATH = Join-Path $root 'plugins-cache'
$env:NUGET_SCRATCH = Join-Path $root 'scratch'
$stage = 'sdk-identity'
# PowerShell command names are case-insensitive. Never name this wrapper after dotnet.
$dotnetExe = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop).Source
if (-not [IO.Path]::IsPathFullyQualified($dotnetExe) -or -not (Test-Path -LiteralPath $dotnetExe -PathType Leaf)) { throw 'Absolute dotnet application path is required' }
function Invoke-DotNetDiagnostic([string[]]$Argv) {
  Check-Reserve | Out-Host
  $output = @(& $dotnetExe @Argv 2>&1)
  $code = $LASTEXITCODE
  $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  if ($text.Length -gt 65536) { throw 'Diagnostic command output exceeds metadata bound' }
  if ($code) { throw ("dotnet command failed ($code): " + $text.Replace($root,'<owned-fixture>')) }
  return $text
}
Push-Location $project
try {
  if ((& $bun --version).Trim() -ne '1.4.4' -or (& $dotnetExe --version).Trim() -ne '10.0.403') { throw 'Actual tool version differs from diagnostic pins' }
  $report.dotnetSdk = '10.0.403'
  $report.targetFramework = 'net10.0-windows'
  $report.packageId = 'Microsoft.Web.WebView2'
  $report.packageVersion = '1.0.4314.35'
  $fixture = Join-Path $project 'NuGetIntegrity.csproj'
  @'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <SelfContained>true</SelfContained>
    <RuntimeFrameworkVersion>10.0.14</RuntimeFrameworkVersion>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
  </PropertyGroup>
  <ItemGroup><PackageReference Include="Microsoft.Web.WebView2" Version="[1.0.4314.35]" /></ItemGroup>
</Project>
'@ | Set-Content -LiteralPath $fixture
  $config = Join-Path $project 'NuGet.Config'
  @'
<configuration><packageSources><clear /><add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" /></packageSources><fallbackPackageFolders><clear /></fallbackPackageFolders></configuration>
'@ | Set-Content -LiteralPath $config
  $stage = 'official-catalog'
  $catalogUrl = 'https://api.nuget.org/v3/catalog0/data/2026.10.23.06.50.10/microsoft.web.webview2.1.0.4314.35.json'
  if ($pins.webView2.metadata -ne $catalogUrl) { throw 'Official metadata pin changed' }
  $catalogResponse = Invoke-WebRequest -Uri $catalogUrl -Headers @{'Cache-Control'='no-cache'} -TimeoutSec 60
  if ($catalogResponse.Content.Length -gt 1MB) { throw 'Catalog metadata exceeds bound' }
  $catalog = $catalogResponse.Content | ConvertFrom-Json
  if ($catalog.id -ine 'Microsoft.Web.WebView2' -or $catalog.version -ne '1.0.4314.35' -or $catalog.packageHashAlgorithm -ine 'SHA512' -or $catalog.packageHash -cne $expected) { throw 'Exact official catalog identity/hash changed' }
  $report.catalog = @{url=$catalogUrl;packageHashAlgorithm='SHA512';packageHash=$catalog.packageHash}
  $restore = @('restore',$fixture,'--runtime','win-x64','--disable-parallel','--no-cache','--configfile',$config)
  $stage = 'new-owned-fixture-lock'
  $null = Invoke-DotNetDiagnostic ($restore + @('--use-lock-file','--packages',$env:NUGET_PACKAGES))
  $lockPath = Join-Path $project 'packages.lock.json'
  if ((Get-Item -LiteralPath $lockPath).Length -gt 65536) { throw 'Fixture lock metadata exceeds bound' }
  $lockDigest = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  $hashes = @($lock.dependencies.PSObject.Properties | ForEach-Object { $_.Value.PSObject.Properties | Where-Object Name -eq 'Microsoft.Web.WebView2' | ForEach-Object { if ($_.Value.resolved -ne '1.0.4314.35') { throw 'Fixture selected another package version' }; $_.Value.contentHash } } | Sort-Object -Unique)
  if ($hashes.Count -ne 1 -or -not $hashes[0]) { throw 'Generated lock lacks one unambiguous WebView2 contentHash' }
  $report.generatedContentHash = $hashes[0]
  $report.fixtureLockSha256 = $lockDigest
  Write-Json (Join-Path $evidence 'fixture-lock.build.json') $lock
  $packageSuffix = 'microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg'
  $firstPackage = Join-Path $env:NUGET_PACKAGES $packageSuffix
  $firstRaw = Sha512-Base64 $firstPackage
  if ($firstRaw -cne $expected) { throw 'First signed archive differs from exact official catalog hash' }
  $report.first = @{rawArchiveBytes=(Get-Item -LiteralPath $firstPackage).Length;rawArchiveSha512=$firstRaw;cacheSha512=(Get-Content -LiteralPath ($firstPackage + '.sha512') -Raw).Trim()}
  $stage = 'locked-repeat-fresh-cache'
  $env:NUGET_PACKAGES = Join-Path $root 'cache-locked'
  $env:NUGET_HTTP_CACHE_PATH = Join-Path $root 'http-locked'
  $null = Invoke-DotNetDiagnostic ($restore + @('--locked-mode','--packages',$env:NUGET_PACKAGES))
  if ((Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lockDigest) { throw 'Locked repeat changed the fixture lock' }
  $package = Join-Path $env:NUGET_PACKAGES $packageSuffix
  $secondRaw = Sha512-Base64 $package
  if ($secondRaw -cne $expected) { throw 'Fresh locked archive differs from exact official catalog hash' }
  $report.lockedRepeat = @{ok=$true;freshCache=$true;lockUnchanged=$true;rawArchiveBytes=(Get-Item -LiteralPath $package).Length;rawArchiveSha512=$secondRaw;cacheSha512=(Get-Content -LiteralPath ($package + '.sha512') -Raw).Trim()}
  $stage = 'signature-verification'
  $signatureText = Invoke-DotNetDiagnostic @('nuget','verify','--all',$package,'--verbosity','detailed')
  [IO.File]::WriteAllText((Join-Path $evidence 'signature-verification.txt'), $signatureText.Replace($root,'<owned-fixture>'), [Text.UTF8Encoding]::new($false))
  $report.signatureVerification = @{ok=$true;command='dotnet nuget verify --all';certificateMetadataFile='signature-verification.txt'}
  $contentHashes = [regex]::Matches($signatureText, '(?m)^Content hash:[\t ]*([A-Za-z0-9+/]{86}==)[\t ]*\r?$')
  if ($contentHashes.Count -ne 1) { throw 'Signature verification did not report exactly one canonical content hash' }
  $report.signatureVerification.contentHash = $contentHashes[0].Groups[1].Value
  $report.generatedHashMatchesSignatureHash = $report.generatedContentHash -ceq $report.signatureVerification.contentHash
  if (-not $report.generatedHashMatchesSignatureHash) { throw 'Generated lock differs from actual signed-package verification content hash' }
  $stage = 'license-notice-metadata'
  $zip = [IO.Compression.ZipFile]::OpenRead($package)
  try {
    $report.signatureEntryPresent = $null -ne $zip.GetEntry('.signature.p7s')
    if (-not $report.signatureEntryPresent) { throw 'Verified package did not contain a signature entry' }
    $notices = @()
    foreach ($entry in $zip.Entries) {
      if ([IO.Path]::GetFileName($entry.FullName) -notmatch '^(LICENSE|NOTICE|THIRD.?PARTY.?NOTICES)([-._].*)?$') { continue }
      if ($entry.Length -gt 1MB -or $notices.Count -ge 16) { throw 'License inventory exceeds metadata bound' }
      $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
      try { $digest = [Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }
      $notices += @{path=$entry.FullName;bytes=$entry.Length;sha256=$digest}
    }
    $report.licenseNoticeEntries = $notices
    $report.embeddedLicenseNoticeFound = $notices.Count -gt 0
  } finally { $zip.Dispose() }
  $report.rawSignedZipDiffersFromNuGetContentHash = $report.generatedContentHash -cne $expected
  # SDK 10.0.403 measured evidence: cache .nupkg.sha512 is the RAW signed ZIP hash.
  # A signed package's lock hash instead matches dotnet nuget verify's canonical hash.
  $report.generatedHashMatchesCacheHash = $report.generatedContentHash -ceq $report.lockedRepeat.cacheSha512
  $report.cacheHashesMatchRawArchives = ($report.first.cacheSha512 -ceq $report.first.rawArchiveSha512) -and ($report.lockedRepeat.cacheSha512 -ceq $report.lockedRepeat.rawArchiveSha512)
  if (-not $report.cacheHashesMatchRawArchives) { throw 'A fresh cache SHA512 file differs from its independently hashed raw signed archive' }
  $report.status = 'verified'
  $report.stage = 'complete'
  Write-Json $reportPath $report
} catch {
  $report.status = 'failed'; $report.stage = $stage
  $message = $_.Exception.Message.Replace($root,'<owned-fixture>')
  $report.error = $message.Substring(0,[Math]::Min(2048,$message.Length))
  Write-Json $reportPath $report
  throw
} finally { Pop-Location }
