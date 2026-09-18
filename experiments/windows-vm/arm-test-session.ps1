$ErrorActionPreference = 'Stop'

# A dedicated throwaway account for the port's measurements, so the owner's own account and its
# password are never touched. Orbit's browser work needs an interactive session (a Chromium family
# browser does not run in Windows session 0), and this guest boots to a lock screen with nobody
# logged on. Removed again by remove-test-user.ps1.

$User = 'orbittest'

# Generated in the guest and written straight to the registry: it never leaves this machine.
Add-Type -AssemblyName System.Web
$Password = [System.Web.Security.Membership]::GeneratePassword(24, 6)
$Secure = ConvertTo-SecureString $Password -AsPlainText -Force

if (Get-LocalUser -Name $User -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $User -Password $Secure
  Write-Output "user: existing, password reset"
} else {
  New-LocalUser -Name $User -Password $Secure -FullName 'Orbit port measurements' -Description 'Throwaway account for Orbit Windows measurements' -PasswordNeverExpires | Out-Null
  Write-Output "user: created"
}
Add-LocalGroupMember -Group 'Administrators' -Member $User -ErrorAction SilentlyContinue
Add-LocalGroupMember -Group 'Users' -Member $User -ErrorAction SilentlyContinue

$Key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty -Path $Key -Name 'AutoAdminLogon' -Value '1' -Type String
Set-ItemProperty -Path $Key -Name 'DefaultUserName' -Value $User -Type String
Set-ItemProperty -Path $Key -Name 'DefaultDomainName' -Value $env:COMPUTERNAME -Type String
Set-ItemProperty -Path $Key -Name 'DefaultPassword' -Value $Password -Type String
# One automatic logon only, so the guest does not sit permanently auto-logging-on after this work.
Set-ItemProperty -Path $Key -Name 'AutoLogonCount' -Value 1 -Type DWord

Write-Output "autologon: armed for $User on $env:COMPUTERNAME"
Write-Output "password length: $($Password.Length)"
