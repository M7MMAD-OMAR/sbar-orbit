#ifndef Payload
  #error Payload must name the verified merged offline payload
#endif
#ifndef PackageVersion
  #error PackageVersion is required
#endif
#ifndef ArtifactOutput
  #define ArtifactOutput "."
#endif
[Setup]
AppId={{619AC6C1-90C7-46C8-9C91-9C38D14AE73A}
AppName=Orbit
AppVersion={#PackageVersion}
AppPublisher=Sbar Orbit contributors
AppPublisherURL=https://github.com/M7MMAD-OMAR/sbar-orbit
DefaultDirName={localappdata}\sbar-orbit\managed
DefaultGroupName=Orbit
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#ArtifactOutput}
OutputBaseFilename=SbarOrbit-{#PackageVersion}-windows-x64-setup
Compression=lzma2
LZMANumBlockThreads=2
SolidCompression=yes
DisableProgramGroupPage=yes
DisableDirPage=yes
WizardStyle=modern
UninstallFilesDir={localappdata}\sbar-orbit-installer
UninstallDisplayName=Orbit
UninstallDisplayIcon={app}\bin\Orbit.exe
CloseApplications=no
RestartApplications=no
SetupLogging=yes
[Files]
; Temporary extraction only. All managed pointers/tasks/runtime installation belong to the central bootstrap.
Source: "{#Payload}\*"; DestDir: "{tmp}\orbit-offline-payload"; Flags: recursesubdirs createallsubdirs dontcopy noencryption
Source: "maintenance.ps1"; DestDir: "{localappdata}\sbar-orbit-installer"; Flags: ignoreversion
[Icons]
Name: "{userprograms}\Orbit"; Filename: "{app}\bin\Orbit.exe"; Parameters: "--launch-current ""{app}"""; Comment: "Orbit native desktop window and managed updates"
[Tasks]
Name: "automaticupdates"; Description: "Enable automatic GUI and CLI payload updates (activation waits for safe managed state)"; Flags: checkedonce
[Run]
Filename: "{app}\bin\Orbit.exe"; Parameters: "--launch-current ""{app}"""; Description: "Open Orbit"; Flags: postinstall nowait skipifsilent unchecked
[Code]
function Quote(Value: String): String;
begin
  Result := '"' + Value + '"';
end;
function WebView2Present(): Boolean;
var Version: String;
begin
  Result := RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  if not Result then Result := RegQueryStringValue(HKLM32, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;
function InitializeSetup(): Boolean;
begin
  Result := WebView2Present();
  if not Result then MsgBox('Microsoft Edge WebView2 Evergreen Runtime is required. Install it explicitly from Microsoft, then run this installer again. Orbit will not silently download a runtime or change your browser profile.', mbError, MB_OK);
  if Result and not WizardSilent() then
    Result := MsgBox('This Orbit installer is unsigned. It does not claim a verified publisher. Windows native application control is not supported yet; this package installs the native management window, CLI and safe update infrastructure. Continue?', mbConfirmation, MB_YESNO) = IDYES;
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Runtime, Entry, Arguments, Automatic: String; ExitCode: Integer;
begin
  Result := '';
  try
    ExtractTemporaryFiles('{tmp}\orbit-offline-payload\*');
    Runtime := ExpandConstant('{tmp}\orbit-offline-payload\runtime\bun.exe');
    Entry := ExpandConstant('{tmp}\orbit-offline-payload\src\windows-managed-install.ts');
    Automatic := 'off';
    if WizardIsTaskSelected('automaticupdates') then Automatic := 'on';
    Arguments := Quote(Entry) + ' install --payload ' + Quote(ExpandConstant('{tmp}\orbit-offline-payload')) + ' --root ' + Quote(ExpandConstant('{app}')) + ' --automatic-updates ' + Automatic;
    if not Exec(Runtime, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Result := 'The central managed installer refused or failed before shell registration. Temporary extraction and diagnostics may exist. No independent pointer/task changes were attempted.';
  except
    Result := 'Orbit could not prepare the verified offline payload. Inspect setup diagnostics; no shell registration was committed.';
  end;
end;
function InitializeUninstall(): Boolean;
var ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + Quote(ExpandConstant('{localappdata}\sbar-orbit-installer\maintenance.ps1')) + ' -Root ' + Quote(ExpandConstant('{app}')), '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
  if not Result then MsgBox('Managed uninstall was refused or could not complete. Close only your own Orbit windows and sessions, inspect diagnostics, then retry. The installer will not kill an existing broker or another application.', mbError, MB_OK);
end;
