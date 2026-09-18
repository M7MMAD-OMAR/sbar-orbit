$ErrorActionPreference = 'Continue'

# Put the guest back: remove the throwaway account the port's measurements ran under, and disarm the
# automatic logon. The owner's own account was never touched and is not touched here either.

$User = 'orbittest'
$Key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

foreach ($name in @('AutoAdminLogon', 'DefaultUserName', 'DefaultDomainName', 'DefaultPassword', 'AutoLogonCount')) {
  Remove-ItemProperty -Path $Key -Name $name -ErrorAction SilentlyContinue
}
Write-Output "autologon: disarmed"

if (Get-LocalUser -Name $User -ErrorAction SilentlyContinue) {
  # The profile directory goes with it: it holds this work's workspaces, journal and connector.
  $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*\$User" })
  Remove-LocalUser -Name $User
  Write-Output "user: removed"
  if ($profilePath) {
    $profilePath | Remove-CimInstance -ErrorAction SilentlyContinue
    Write-Output "profile: removed"
  }
} else {
  Write-Output "user: already absent"
}

Write-Output ("remaining enabled accounts: " + ((Get-LocalUser | Where-Object Enabled | ForEach-Object { $_.Name }) -join ', '))
