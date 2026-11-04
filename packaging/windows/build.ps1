param([ValidateSet('Probe','Build')][string]$Phase = 'Build')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This build/acceptance driver requires its dedicated hosted CI account' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location $repo
$build = Join-Path $env:RUNNER_TEMP 'orbit-windows-candidate'
$evidence = Join-Path $build 'owned-windows-acceptance'
$pins = Get-Content desktop/windows/build-pins.json -Raw | ConvertFrom-Json
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$archive = Join-Path $build 'bun-runtime.zip'
$bun = Join-Path $build 'bun/bun-windows-x64/bun.exe'
function Run-Bounded([string[]]$Argv) {
  & "$PSScriptRoot/preflight.ps1"
  & $bun (Join-Path $repo 'scripts/limited.ts') @Argv
  if ($LASTEXITCODE) { throw "Owned build step failed: $LASTEXITCODE" }
}
if ($Phase -eq 'Probe') {
  & "$PSScriptRoot/preflight.ps1"
  New-Item -ItemType Directory -Path $build -ErrorAction Stop | Out-Null
  New-Item -ItemType Directory -Path $evidence | Out-Null
  Invoke-WebRequest -Uri $pins.bun.url -OutFile $archive
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $pins.bun.sha256) { throw 'Official Bun archive digest differs' }
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $build 'bun')
  if (-not (Test-Path -LiteralPath $bun)) { throw 'Pinned Bun layout missing' }
  Run-Bounded @($bun,'install','--frozen-lockfile','--ignore-scripts','--linker','hoisted')
  # A real production IPC bind/client roundtrip fails here BEFORE any SDK download/restore.
  Run-Bounded @($bun,'run','scripts/windows-desktop-acceptance.ts','probe','--report',($evidence + '/ipc-probe.json'))
  return
}
$probe = Get-Content "$evidence/ipc-probe.json" -Raw | ConvertFrom-Json
if (-not $probe.ok -or -not $probe.actualDefaultIpc -or $probe.simulated -or $probe.platform -ne 'win32') { throw 'Actual Windows IPC probe must pass before SDK work' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $pins.bun.sha256) { throw 'Pinned runtime probe artifact changed' }
$root = [IO.Path]::GetFullPath($probe.root)
if (Test-Path -LiteralPath $root) { throw 'Default production root appeared after probe; preserve it and refuse' }
$disk = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($build))
if ($disk.AvailableFreeSpace -lt 4GB) { throw 'Owned build disk reserve unavailable; nothing will be deleted to make room' }
Push-Location desktop/windows
try {
  Run-Bounded @('dotnet','restore','Orbit.Desktop.csproj','--locked-mode','--runtime','win-x64','--disable-parallel')
  Run-Bounded @('dotnet','publish','Orbit.Desktop.csproj','-c','Release','-r','win-x64','--self-contained','true','--no-restore','--maxcpucount:2',('-p:Version=' + $version),('-p:PublishDir=' + $build + '/published/'))
} finally { Pop-Location }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler unavailable' }
Run-Bounded @($compiler,'/nologo','/optimize+','/target:winexe','/platform:x64','/r:System.Core.dll','/r:System.Web.Extensions.dll','/r:System.Windows.Forms.dll',('/out:' + $build + '/Orbit.Launcher.exe'),'packaging/windows/OrbitLauncher.cs','packaging/windows/PreparedRelease.cs')
# Bundle actual vendor license/notice files. Missing terms are a release-blocking gap, not Orbit Apache coverage.
$nuget = $env:NUGET_PACKAGES
if (-not $nuget) { $nuget = Join-Path $env:USERPROFILE '.nuget/packages' }
function Add-VendorNotices([string]$Published) {
  $notices = Join-Path $Published 'third-party-notices'
  New-Item -ItemType Directory -Force $notices | Out-Null
  $inventory = @()
  foreach ($entry in @(@('DotNetCore',('microsoft.netcore.app.runtime.win-x64/' + $pins.dotnetRuntime)),@('DotNetDesktop',('microsoft.windowsdesktop.app.runtime.win-x64/' + $pins.dotnetRuntime)),@('WebView2',('microsoft.web.webview2/' + $pins.webView2.version)))) {
    $package = Join-Path $nuget $entry[1]
    $files = @(Get-ChildItem -LiteralPath $package -File -Recurse | Where-Object { $_.Name -match '^(LICENSE|THIRD.?PARTY.?NOTICES|NOTICE)([-._].*)?$' })
    if ($files.Count -eq 0) { throw ('Vendor license/notice gap: ' + $entry[0]) }
    foreach ($file in $files) {
      $relative = [IO.Path]::GetRelativePath($package,$file.FullName)
      $destination = Join-Path (Join-Path $notices $entry[0]) $relative
      New-Item -ItemType Directory -Force (Split-Path $destination) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $destination
      $inventory += @{vendor=$entry[0];file=[IO.Path]::GetRelativePath($Published,$destination);sha256=(Get-FileHash $destination -Algorithm SHA256).Hash.ToLowerInvariant();source=$entry[1]}
    }
  }
  $bunNotice = Join-Path $notices 'Bun/LICENSE.md'
  New-Item -ItemType Directory -Force (Split-Path $bunNotice) | Out-Null
  Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.4/LICENSE.md' -OutFile $bunNotice
  if ((Get-FileHash $bunNotice -Algorithm SHA256).Hash.ToLowerInvariant() -ne '362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd') { throw 'Pinned upstream Bun notice digest differs' }
  $inventory += @{vendor='Bun';file='third-party-notices/Bun/LICENSE.md';sha256='362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd';source='bun-v1.4.4/LICENSE.md'}
  @{schema=1;files=$inventory;orbitLicenseDoesNotCoverVendors=$true;redistributionReview='required: Bun statically linked JavaScriptCore/WebCore LGPL2 relinking/source obligations and Microsoft WebView2 SDK/runtime terms'} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Published 'vendor-notice-inventory.json')
}
Add-VendorNotices "$build/published"
Run-Bounded @($bun,'run','scripts/registry-package.ts',($build + '/source-archive'),'--ref',$env:GITHUB_SHA)
$archives = @(Get-ChildItem "$build/source-archive/*.tgz")
if ($archives.Count -ne 1) { throw 'Expected one audited source package' }
New-Item -ItemType Directory "$build/source" | Out-Null
Run-Bounded @('tar.exe','-xf',$archives[0].FullName,'-C',($build + '/source'))
Push-Location "$build/source/package"
try { Run-Bounded @($bun,'install','--frozen-lockfile','--production','--ignore-scripts','--linker','hoisted') } finally { Pop-Location }
Run-Bounded @($bun,'run','scripts/package-windows.ts',($build + '/source/package'),($build + '/published'),$bun,($build + '/Orbit.Launcher.exe'),($build + '/artifacts'),$env:GITHUB_SHA)
$iscc = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Inno Setup 6/ISCC.exe'
if (-not (Test-Path -LiteralPath $iscc)) { throw 'Trusted runner Inno Setup compiler unavailable' }
Run-Bounded @($iscc,('/DPayload=' + $build + '/artifacts/installer-payload'),('/DPackageVersion=' + $version),('/DArtifactOutput=' + $build + '/artifacts'),'packaging/windows/Orbit.iss')
$installer = Join-Path $build "artifacts/SbarOrbit-$version-windows-x64-setup.exe"
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
"$digest  $(Split-Path -Leaf $installer)" | Set-Content -Encoding ascii "$installer.sha256"
@{compiler=(Get-Item $iscc).VersionInfo.FileVersion;sha256=$digest;authenticode='unsigned';published=$false;vendorRedistributionReview='pending'} | ConvertTo-Json | Set-Content "$installer.build.json"
# Build two actual unpublished GUI/host variants. No patched PE or fictional public release.
foreach ($variant in @(@('activation',$probe.versions.activation),@('rollback',$probe.versions.rollback))) {
  $label = $variant[0]; $fixtureVersion = $variant[1]
  Push-Location desktop/windows
  try { Run-Bounded @('dotnet','publish','Orbit.Desktop.csproj','-c','Release','-r','win-x64','--self-contained','true','--no-restore','--maxcpucount:2',('-p:Version=' + $fixtureVersion),('-p:PublishDir=' + $build + '/' + $label + '-published/')) } finally { Pop-Location }
  Add-VendorNotices "$build/$label-published"
  $stamp = Join-Path $build "$label-AssemblyInfo.cs"
  ('[assembly:System.Reflection.AssemblyInformationalVersion("' + $fixtureVersion + '")]') | Set-Content -Encoding utf8 $stamp
  $host = Join-Path $build "$label-Orbit.Launcher.exe"
  Run-Bounded @($compiler,'/nologo','/optimize+','/target:winexe','/platform:x64','/r:System.Core.dll','/r:System.Web.Extensions.dll','/r:System.Windows.Forms.dll',('/out:' + $host),'packaging/windows/OrbitLauncher.cs','packaging/windows/PreparedRelease.cs',$stamp)
  Run-Bounded @($bun,'run','scripts/windows-desktop-acceptance.ts','prepare','--base',($build + '/artifacts/installer-payload'),'--gui',($build + '/' + $label + '-published'),'--launcher',$host,'--version',$fixtureVersion,'--destination',($build + '/' + $label + '-fixture'),'--evidence',$evidence)
}
function File-Fingerprint([string]$Path) { if (Test-Path -LiteralPath $Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash }; return 'absent' }
function Shell-Snapshot {
  $shortcut = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft/Windows/Start Menu/Programs/Orbit.lnk'
  $maintenance = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'sbar-orbit-installer/maintenance.ps1'
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{619AC6C1-90C7-46C8-9C91-9C38D14AE73A}_is1'
  $registration = if (Test-Path $key) { Get-ItemProperty $key | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString } else { $null }
  $tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like '*sbar-orbit*' } | Sort-Object TaskName)
  if ($tasks.Count -gt 32) { throw 'Unexpected owned task snapshot size' }
  $taskXml = @($tasks | ForEach-Object { Export-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath }) -join "\n"
  return ([ordered]@{shortcut=(File-Fingerprint $shortcut);maintenance=(File-Fingerprint $maintenance);registration=$registration;tasks=$taskXml} | ConvertTo-Json -Depth 4 -Compress)
}
& "$PSScriptRoot/preflight.ps1"
if (Test-Path -LiteralPath $root) { throw 'Normal CI root is not absent; no fixture may overwrite it' }
New-Item -ItemType Directory $root -Force | Out-Null
$sentinel = Join-Path $root 'owner-sentinel.txt'
Set-Content -LiteralPath $sentinel -Value 'owned refusal fixture'
$beforeSentinel = File-Fingerprint $sentinel; $beforeShell = Shell-Snapshot
$refusal = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS=',('/DIR="' + $root + '"')) -PassThru
if (-not $refusal.WaitForExit(120000)) { $refusal.Kill($true); $refusal.WaitForExit(3000); throw 'Owned refusal installer exceeded deadline' }
if ($refusal.ExitCode -ne 7 -or (File-Fingerprint $sentinel) -ne $beforeSentinel -or (Shell-Snapshot) -ne $beforeShell -or (Test-Path (Join-Path $root 'current.txt'))) { throw 'Central refusal/shell evidence failed' }
@{schema=1;exitCode=$refusal.ExitCode;sentinelPreserved=$true;shellSnapshotUnchanged=$true;currentAbsent=$true;temporaryDiagnosticsMayExist=$true} | ConvertTo-Json | Set-Content "$evidence/installer-refusal.json"
# Delete ONLY the exact sentinel created above, after its bytes and canonical parent are checked.
if ([IO.Path]::GetFullPath($sentinel) -ne (Join-Path $root 'owner-sentinel.txt') -or (File-Fingerprint $sentinel) -ne $beforeSentinel) { throw 'Owned sentinel identity changed' }
Remove-Item -LiteralPath $sentinel
if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne 0) { throw 'Refusal left unknown root state; preserve it and stop' }
& "$PSScriptRoot/preflight.ps1"
$installed = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS=',('/DIR="' + $root + '"'),('/LOG="' + $build + '/install.log"')) -PassThru
if (-not $installed.WaitForExit(120000)) { $installed.Kill($true); $installed.WaitForExit(3000); throw 'Owned installer exceeded deadline' }
if ($installed.ExitCode -ne 0) { throw "Owned installer failed: $($installed.ExitCode)" }
Run-Bounded @((Join-Path $root 'bin/Orbit.exe'),'--cli',$root,'help')
$smoke = Join-Path $build 'owned-gui-smoke'
$gui = Join-Path $root "versions/$version/desktop/windows-app/Orbit.Desktop.exe"
$verifier = Join-Path $root "versions/$version/src/windows-managed-install.ts"
$originalVerifier = [IO.File]::ReadAllBytes($verifier)
$sentinel = Join-Path $build 'verifier-should-not-execute.txt'; $sentinelJson = ConvertTo-Json -Compress $sentinel
try {
  $altered = [Text.Encoding]::UTF8.GetBytes('await Bun.write(' + $sentinelJson + ', "unsafe");' + [Environment]::NewLine + [Text.Encoding]::UTF8.GetString($originalVerifier))
  [IO.File]::WriteAllBytes($verifier, $altered)
  & (Join-Path $root 'bin/Orbit.exe') --cli $root help
  if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $sentinel)) { throw 'Thin launcher executed changed verifier before source attestation' }
  $rejectedGui = Start-Process -FilePath $gui -ArgumentList @('--smoke-output', ('"' + $build + '/rejected-gui"')) -PassThru
  if (-not $rejectedGui.WaitForExit(45000)) { $rejectedGui.Kill($true); $rejectedGui.WaitForExit(3000); throw 'Changed-source GUI refusal timed out' }
  if ($rejectedGui.ExitCode -eq 0 -or (Test-Path -LiteralPath $sentinel)) { throw 'Direct GUI executed changed verifier before source attestation' }
} finally { [IO.File]::WriteAllBytes($verifier, $originalVerifier) }
$process = Start-Process -FilePath $gui -ArgumentList @('--smoke-output', ('"' + $smoke + '"')) -PassThru
if (-not $process.WaitForExit(60000)) { $process.Kill($true); $process.WaitForExit(3000); throw 'Owned GUI smoke exceeded deadline' }
if ($process.ExitCode -ne 0) { throw "Owned GUI failed: $($process.ExitCode)" }
$proof = Get-Content (Join-Path $smoke 'smoke.json') -Raw | ConvertFrom-Json
if (-not $proof.nativeWindow -or -not $proof.visible -or $proof.version -ne $version -or $proof.desktopControl -ne 'unsupported') { throw 'Actual native GUI proof incomplete' }
if (-not (Test-Path (Join-Path $smoke 'orbit-window.png'))) { throw 'Actual owned GUI surface screenshot missing' }
Run-Bounded @($bun,'run','scripts/windows-desktop-acceptance.ts','activate','--candidate',($build + '/activation-fixture'),'--rollback',($build + '/rollback-fixture'),'--evidence',$evidence)
