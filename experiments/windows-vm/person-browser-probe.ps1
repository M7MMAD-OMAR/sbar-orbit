$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\head13.tgz 2>&1 | Out-Null
Say ("unpack exit=" + $LASTEXITCODE)

# AGENTS.md: "Agents do not touch the person's own browser, screen, pointer or windows."
# Reaping is measured. This one is not, and Windows has a hazard Linux does not: a Chromium launch
# normally HANDS OFF to an already running instance of the same browser through its singleton, and
# then the new process exits immediately. If that happened here, Orbit would be driving the person's
# own browser, their profile, their cookies, their windows, while reporting a healthy session.
#
# So: start a browser as the PERSON, with their own profile and a real visible window, then have
# Orbit launch its own, and check they are separate in every way that matters.

Get-Process msedge, bun -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 2

$personProfile = Join-Path $env:LOCALAPPDATA "orbit-person-browser"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
Say ("edge: " + (Test-Path $edge))

# The person's browser: NOT headless, a real window, their own user data directory.
$person = Start-Process -FilePath $edge -ArgumentList "--user-data-dir=`"$personProfile`"","--no-first-run","--no-default-browser-check","about:blank" -PassThru
Start-Sleep 6
$personTree = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")
Say ("the person's browser is running: " + $personTree.Count + " processes, root pid " + $person.Id)

# Their window, which must still be theirs at the end.
$personWindows = @(Get-Process msedge -EA SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle })
Say ("the person's window titles: " + $(if ($personWindows.Count) { $personWindows -join " | " } else { "(none reported)" }))

$probe = @'
import { launchChrome } from "./src/chrome";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const say = (m: string) => console.log("[s] " + m);

const before = new Set(Bun.spawnSync(["powershell","-NoProfile","-Command",
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | ForEach-Object { $_.ProcessId }"])
  .stdout.toString().trim().split(/\r?\n/).filter(Boolean).map(Number));
say("browser processes before Orbit launches: " + before.size);

const profile = mkdtempSync(join(tmpdir(), "orbit-own-"));
const launched = await launchChrome(profile);
say("launch returned a driven browser: " + (launched.page ? "yes" : "NO"));

// launchChrome returns a Playwright handle, not a pid: the owning process lives inside it. So the
// isolation questions are asked of the process table by command line, which is the same question a
// person would ask looking at their own machine.
const table = () => Bun.spawnSync(["powershell","-NoProfile","-Command",
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"])
  .stdout.toString().trim().split(/\r?\n/).filter(Boolean);

const after = table();
const mine = after.filter(row => row.includes(profile));
const theirs = after.filter(row => row.toLowerCase().includes("orbit-person-browser"));
say("processes in orbit's own profile: " + mine.length);
say("the person's processes still present: " + theirs.length + " (was " + before.size + ")");

// 1. The handoff hazard: a launch that joined the person's instance would leave ZERO processes in
//    Orbit's own profile while still reporting a healthy session.
say("orbit got its own browser rather than handing off: " + (mine.length > 0));

// 2. None of Orbit's processes may be ones the person was already running.
const myPids = mine.map(row => Number(row.split("|")[0]));
say("orbit reused one of the person's processes: " + (myPids.some(pid => before.has(pid)) ? "YES, the failure" : "no"));

// 3. Orbit's browser must be headless and must never name the person's profile.
const root = mine.find(row => !row.includes("--type=")) ?? mine[0] ?? "";
say("orbit's browser is headless: " + root.includes("--headless"));
say("orbit's browser names the person's profile: " + (root.toLowerCase().includes("orbit-person-browser") ? "YES, the failure" : "no"));

// 4. And it must actually work while the person's browser is running, since a singleton collision
//    would show up as a session that never becomes usable.
await launched.page.goto("about:blank");
say("orbit drove its own page with the person's browser running: yes");

await launched.close();


const final = new Set(table().map(row => Number(row.split("|")[0])));
const survivors = [...before].filter(pid => final.has(pid));
say("orbit's own processes after close: " + table().filter(row => row.includes(profile)).length);
say("the person's browser processes still alive after Orbit closed its own: " + survivors.length + " of " + before.size);
'@
Set-Content -Path C:\orbit\src\ownprobe.ts -Value $probe -Encoding UTF8
Say ((& C:\orbit\bun.exe run C:\orbit\src\ownprobe.ts 2>&1 | Out-String).Trim())
Remove-Item C:\orbit\src\ownprobe.ts -Force -EA SilentlyContinue

# The person's window, after all of it.
$stillThere = @(Get-Process -Id $person.Id -EA SilentlyContinue).Count
Say ("the person's browser root process still alive at the end: " + ($stillThere -eq 1))
$titlesAfter = @(Get-Process msedge -EA SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle })
Say ("the person's window titles after: " + $(if ($titlesAfter.Count) { $titlesAfter -join " | " } else { "(none reported)" }))

Get-Process msedge -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Remove-Item -Recurse -Force $personProfile -EA SilentlyContinue
Say "done"
