@echo off
setlocal EnableDelayedExpansion
rem Sbar Orbit's Windows launcher.
rem
rem bin/sbar-orbit is a bash script, so until this file existed no Orbit command could be run on
rem Windows at all: the broker, the doctor report and the MCP adapter were reachable only by importing
rem them from Bun by hand. This is the same dispatcher, written for cmd.exe, and it refuses by name
rem the subcommands that are Linux only rather than letting them fail somewhere further down.
rem
rem What it deliberately does NOT do is install a service. A Chromium family browser cannot run in
rem Windows session 0, measured on the guest, so a broker belongs in the person's own session and
rem there is no analogue of loginctl enable-linger. See docs/support-tiers.md.

set "orbit_bin=%~dp0"
for %%I in ("%orbit_bin%..") do set "orbit_root=%%~fI"

rem Bun by location, not by the caller's PATH, for the same reason the bash launcher gives: a service
rem or an agent host starts this with its own PATH, which need not carry Bun at all.
set "orbit_bun="
for /f "delims=" %%I in ('where bun.exe 2^>nul') do if not defined orbit_bun set "orbit_bun=%%I"
if not defined orbit_bun if defined BUN_INSTALL if exist "%BUN_INSTALL%\bin\bun.exe" set "orbit_bun=%BUN_INSTALL%\bin\bun.exe"
if not defined orbit_bun if exist "%USERPROFILE%\.bun\bin\bun.exe" set "orbit_bun=%USERPROFILE%\.bun\bin\bun.exe"
if not defined orbit_bun if exist "%LOCALAPPDATA%\Programs\bun\bun.exe" set "orbit_bun=%LOCALAPPDATA%\Programs\bun\bun.exe"
rem A single line branch, for the reason given at :status: a multi line ( ) block is what stops
rem behaving when a batch file is checked out with LF endings, and the one path that must never fail
rem obscurely is the one that says Bun is missing.
if not defined orbit_bun goto :no_bun

set "orbit_command=%~1"
if "%orbit_command%"=="" set "orbit_command=help"

rem Everything after the subcommand, verbatim. `shift` moves %1..%9 and leaves %* alone, so forwarding
rem %1 %2 %3 %4 after a shift silently DROPS a fifth argument: the bash launcher passes "$@" and does
rem not. Splitting %* once on its first space is the batch equivalent, and it keeps the caller's own
rem quoting, which matters for a path with a space in it.
set "orbit_rest="
for /f "tokens=1,* delims= " %%a in ("%*") do set "orbit_rest=%%b"

if "%orbit_command%"=="help" goto :help
if "%orbit_command%"=="--help" goto :help
if "%orbit_command%"=="-h" goto :help

if "%orbit_command%"=="preflight" goto :preflight
if "%orbit_command%"=="serve" goto :serve
if "%orbit_command%"=="status" goto :status
if "%orbit_command%"=="mcp" goto :adapter
if "%orbit_command%"=="connector-config" goto :adapter
rem Through limited.ts, like the bash launcher: on Windows that joins the shared job object rather
rem than shelling out to systemd-run, so an install runs inside the same budget everything else does.
if "%orbit_command%"=="install" goto :install

rem Linux only, each for a reason this project has measured rather than assumed.
if "%orbit_command%"=="service" goto :no_service
if "%orbit_command%"=="autostart" goto :no_service
if "%orbit_command%"=="panel" goto :no_desktop
if "%orbit_command%"=="settings" goto :no_desktop
if "%orbit_command%"=="config" goto :no_desktop

rem doctor, clean, diagnostics and anything else the CLI grows.
"%orbit_bun%" run "%orbit_root%\src\cli.ts" %*
exit /b %errorlevel%

:preflight
"%orbit_bun%" run "%orbit_root%\scripts\preflight.ts" %orbit_rest%
exit /b %errorlevel%

:serve
"%orbit_bun%" run "%orbit_root%\scripts\limited.ts" "%orbit_bun%" run "%orbit_root%\src\cli.ts" serve %orbit_rest%
exit /b %errorlevel%

:status
rem --watch ANYWHERE in the arguments, which is what the bash launcher's `case " $* "` does. Matching
rem the first argument alone made `status --json --watch` run the watcher on Linux and the one shot
rem status on Windows, silently doing a different thing for the same command.
rem A string compare rather than a pipe into findstr: no subshell, and nothing to escape when an
rem argument carries a character cmd would otherwise read as syntax.
rem A single line `if ... goto` rather than a multi line block, because a block is the construct that
rem breaks when a batch file is checked out with LF endings, and this one did on the guest: the branch
rem was never taken and `status --json --watch` ran the one shot. .gitattributes now ships this file
rem with CRLF, and the branch does not depend on that being true.
if not "%orbit_rest%"=="%orbit_rest:--watch=%" goto :watch
"%orbit_bun%" run "%orbit_root%\src\cli.ts" status %orbit_rest%
exit /b %errorlevel%

:watch
"%orbit_bun%" run "%orbit_root%\src\status.ts" --watch
exit /b %errorlevel%

:adapter
rem The path this launcher was invoked by, so generated agent configuration names a stable entry
rem rather than the version behind it. Set only here, because every other subcommand starts a
rem browser and a path under the person's home has no business in a browser's environment.
set "ORBIT_LAUNCHER=%~f0"
"%orbit_bun%" run "%orbit_root%\src\%orbit_command%.ts" %orbit_rest%
exit /b %errorlevel%

:install
"%orbit_bun%" run "%orbit_root%\scripts\limited.ts" "%orbit_bun%" run "%orbit_root%\scripts\install.ts" %orbit_rest%
exit /b %errorlevel%

:no_bun
echo sbar-orbit: bun was not found on PATH, in %%BUN_INSTALL%%, ~\.bun\bin or %%LOCALAPPDATA%%\Programs\bun; install Bun 1.3 or newer 1>&2
exit /b 127

:no_service
echo sbar-orbit: there is no Orbit service on Windows. A Chromium family browser does not run in 1>&2
echo session 0, so the broker belongs in your own session: run "sbar-orbit serve" there. 1>&2
echo See docs/support-tiers.md. 1>&2
exit /b 2

:no_desktop
echo sbar-orbit: the panel, the settings window and the config command are GTK and Python, and are 1>&2
echo Linux only. The broker, the browser sessions and the MCP adapter are not. 1>&2
exit /b 2

:help
echo Sbar Orbit, local agent workspace prototype ^(Windows^)
echo.
echo   sbar-orbit serve               Start the broker with the shared job object budget
echo   sbar-orbit status              Sessions, tabs and windows
echo   sbar-orbit status --watch      Print a line whenever that changes
echo   sbar-orbit doctor              Inspect the running broker and its resources
echo   sbar-orbit doctor --report     Host class and capabilities, needs no broker
echo   sbar-orbit preflight           Check prerequisites without starting anything
echo   sbar-orbit clean               Remove workspaces no running broker owns
echo   sbar-orbit diagnostics         Prepare a private report and an issue link
echo   sbar-orbit connector-config    Print MCP configuration for an agent host
echo   sbar-orbit connector-config --no-launcher
echo                                  For a host that cannot spawn a .cmd
echo   sbar-orbit mcp                 Run the stdio MCP adapter
echo.
echo Linux only, and refused here by name rather than failing later: service, autostart,
echo panel, settings, config. See docs\support-tiers.md for what Windows can and cannot do.
echo.
echo ORBIT_SOCKET selects another broker; without it the managed socket under %%LOCALAPPDATA%% is used.
exit /b 0
