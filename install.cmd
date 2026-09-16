@echo off
setlocal EnableDelayedExpansion
rem The whole installation, from a fresh checkout, in one command:
rem
rem   install.cmd
rem
rem This is install.sh for Windows. It exists because docs/agent-install.md says the contract is "not
rem written for one operating system either", while the only entry point it named was a bash script:
rem on Windows the documented install did not exist at all, and an agent following the contract there
rem had nothing to run. Both files delegate to the same scripts/install.ts, so there is one installer
rem and two doors into it.
rem
rem What it deliberately does NOT check is systemd. install.sh stops without a usable systemd user
rem session because that is where the Linux budget lives. Windows has no analogue: the shared budget
rem is a named job object, joined by the process itself, so there is nothing to verify before starting.
rem What it also does not install is a service, for the reason bin\sbar-orbit.cmd gives: a Chromium
rem family browser cannot run in Windows session 0, so the broker belongs in the person's own session.

set "orbit_root=%~dp0"
if "%orbit_root:~-1%"=="\" set "orbit_root=%orbit_root:~0,-1%"

rem Bun by location rather than by the caller's PATH, the same search bin\sbar-orbit.cmd uses: an
rem agent host starts this with its own environment, which need not carry Bun at all.
set "orbit_bun="
for /f "delims=" %%I in ('where bun.exe 2^>nul') do if not defined orbit_bun set "orbit_bun=%%I"
if not defined orbit_bun if defined BUN_INSTALL if exist "%BUN_INSTALL%\bin\bun.exe" set "orbit_bun=%BUN_INSTALL%\bin\bun.exe"
if not defined orbit_bun if exist "%USERPROFILE%\.bun\bin\bun.exe" set "orbit_bun=%USERPROFILE%\.bun\bin\bun.exe"
if not defined orbit_bun if exist "%LOCALAPPDATA%\Programs\bun\bun.exe" set "orbit_bun=%LOCALAPPDATA%\Programs\bun\bun.exe"
if not defined orbit_bun goto :no_bun

pushd "%orbit_root%"
"%orbit_bun%" run scripts\limited.ts "%orbit_bun%" run scripts\install.ts %*
set "orbit_status=%ERRORLEVEL%"
popd
exit /b %orbit_status%

:no_bun
rem To stderr, and exit 1, so an agent reading the contract sees this the way it sees any other
rem failure rather than parsing a success stream that happens to contain a complaint.
echo Orbit runs on Bun, and this machine does not have it yet.>&2
echo.>&2
echo   powershell -c "irm bun.sh/install.ps1 ^| iex">&2
echo.>&2
echo Then open a new shell and run install.cmd again.>&2
exit /b 1
