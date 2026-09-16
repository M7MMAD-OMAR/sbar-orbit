$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
$ProgressPreference = "SilentlyContinue"

# git is genuinely absent on this guest and six tests need it. winget hung in an earlier session, so
# MinGit is fetched directly: it is the portable Git for Windows build, a zip with no installer and no
# elevation, which is exactly what an unattended guest can take.
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -UseBasicParsing
Say ("release: " + $rel.tag_name)
$asset = $rel.assets | Where-Object { $_.name -like "MinGit-*-64-bit.zip" } | Select-Object -First 1
if (-not $asset) { Say "NO MINGIT ASSET"; exit 1 }
Say ("asset: " + $asset.name + " " + [math]::Round($asset.size/1MB,1) + " MB")

$zip = "C:\orbit\mingit.zip"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
Say ("downloaded: " + [math]::Round((Get-Item $zip).Length/1MB,1) + " MB")

Remove-Item -Recurse -Force C:\orbit\git -EA SilentlyContinue
Expand-Archive -Path $zip -DestinationPath C:\orbit\git -Force
Say ("git.exe present: " + (Test-Path C:\orbit\git\cmd\git.exe))
Say ((& C:\orbit\git\cmd\git.exe --version) 2>&1)

# On PATH for the user, so the suite's bare `git` spawns resolve the way they would on a real machine.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*C:\orbit\git\cmd*") {
  [Environment]::SetEnvironmentVariable("Path", $userPath + ";C:\orbit\git\cmd", "User")
  Say "added to the user PATH"
} else { Say "already on the user PATH" }
Remove-Item $zip -Force -EA SilentlyContinue
Say "done"
