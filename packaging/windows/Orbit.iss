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
var RuntimeConsent: TInputOptionWizardPage;
procedure InitializeWizard();
begin
  RuntimeConsent := CreateInputOptionPage(wpSelectTasks, 'Private Bun runtime', 'Bun is not bundled in this installer', 'Orbit needs Bun 1.4.4 from the official oven-sh GitHub release, downloaded privately and hash-checked. Bun includes third-party terms: https://github.com/oven-sh/bun/blob/bun-v1.4.4/LICENSE.md . No global installation or browser profile changes. Select download explicitly, or supply /BUNRUNTIMEARCHIVE=PATH to the exact official ZIP.', False, False);
  RuntimeConsent.Add('I consent to downloading the pinned official Bun runtime into private staging');
  RuntimeConsent.Values[0] := False;
end;
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
var Helper, Arguments, Automatic, Archive, Consent, Report, ErrorMessage: String; ExitCode: Integer; Started: Boolean;
begin
  Result := '';
  try
    Log('Orbit bootstrap stage: consent');
    Report := ExpandConstant('{param:BOOTSTRAPREPORT|}');
    if Report = '' then Report := ExpandConstant('{tmp}\orbit-bootstrap-result.json');
    Archive := ExpandConstant('{param:BUNRUNTIMEARCHIVE|}');
    Consent := '';
    if Archive <> '' then Consent := ' --archive ' + Quote(Archive)
    else if (WizardSilent() and (ExpandConstant('{param:ACCEPTBUNRUNTIMEDOWNLOAD|0}') = '1')) or ((not WizardSilent()) and RuntimeConsent.Values[0]) then Consent := ' --download-consent accepted'
    else begin Result := 'Explicit Bun download consent or a matching official archive is required. No runtime is bundled and no implicit download will occur.'; exit; end;
    Log('Orbit bootstrap stage: extraction');
    ExtractTemporaryFiles('{tmp}\orbit-offline-payload\*');
    Helper := ExpandConstant('{tmp}\orbit-offline-payload\desktop\windows-app\Orbit.RuntimeBootstrap.exe');
    Automatic := 'off';
    if WizardIsTaskSelected('automaticupdates') then Automatic := 'on';
    Arguments := 'install --payload ' + Quote(ExpandConstant('{tmp}\orbit-offline-payload')) + ' --root ' + Quote(ExpandConstant('{app}')) + ' --automatic-updates ' + Automatic + Consent + ' --report ' + Quote(Report);
    Log('Orbit bootstrap stage: native helper launch');
    Log('Orbit bootstrap helper path: ' + Helper);
    Log('Orbit private bootstrap report path: ' + Report);
    Started := Exec(Helper, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
    if Started then Log('Orbit bootstrap helper exit code: ' + IntToStr(ExitCode))
    else Log('Orbit bootstrap launch failed, system code: ' + IntToStr(ExitCode));
    if (not Started) or (ExitCode <> 0) then
      Result := 'The central managed installer refused or failed before shell registration. Temporary extraction and diagnostics may exist. No independent pointer/task changes were attempted.';
  except
    ErrorMessage := Lowercase(GetExceptionMessage());
    if Pos('access', ErrorMessage) > 0 then Log('Orbit preparation exception category: access')
    else if Pos('not found', ErrorMessage) > 0 then Log('Orbit preparation exception category: missing input')
    else Log('Orbit preparation exception category: other; raw details remain private');
    Result := 'Orbit could not prepare the verified offline payload. Inspect setup diagnostics; no shell registration was committed.';
  end;
end;
function InitializeUninstall(): Boolean;
var ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + Quote(ExpandConstant('{localappdata}\sbar-orbit-installer\maintenance.ps1')) + ' -Root ' + Quote(ExpandConstant('{app}')), '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
  if not Result then MsgBox('Managed uninstall was refused or could not complete. Close only your own Orbit windows and sessions, inspect diagnostics, then retry. The installer will not kill an existing broker or another application.', mbError, MB_OK);
end;
