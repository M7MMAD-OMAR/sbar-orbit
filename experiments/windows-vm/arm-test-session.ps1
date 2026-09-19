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

# Verify the registry rather than trusting the writes above, and do it BEFORE the reboot.
#
# This script generates a NEW password on every run and resets the account to it. When a previous run
# had already armed autologon and the guest rebooted without consuming it, the stored DefaultPassword
# and the account password can disagree, and the guest then boots to "The password is incorrect. Try
# again." with nobody logged on. Every probe after that returns an empty string, which reads as "no
# output" rather than as "never ran": the same silent failure mode documented in section 27, arriving
# by a different route. A failed read here is worth one line now instead of a wasted suite run.
$check = Get-ItemProperty -Path $Key
$ok = ($check.AutoAdminLogon -eq '1') -and ($check.DefaultUserName -eq $User) -and ($check.DefaultPassword.Length -eq $Password.Length)
Write-Output "autologon verified: $ok (user=$($check.DefaultUserName) count=$($check.AutoLogonCount) pwlen=$($check.DefaultPassword.Length))"
if (-not $ok) { Write-Output 'FATAL: autologon did not take, do not reboot expecting a session'; exit 1 }
