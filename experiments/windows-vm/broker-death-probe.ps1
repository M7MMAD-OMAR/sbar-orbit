$ErrorActionPreference = "Continue"
$env:NO_COLOR = "1"
Set-Location C:\orbit\src
& tar.exe -xzf C:\orbit\head9.tgz 2>&1 | Out-Null
Say ("unpack exit=" + $LASTEXITCODE)

# THE guarantee this project exists for: an agent's browser must not outlive the broker that owned
# it. On Linux a subreaper plus the cgroup enforces it and tests/browser-crash.test.ts proves it by
# walking /proc. Windows has no /proc, so that test fails for a harness reason and the property
# itself has never been measured through a real broker death here. Job object reaping was measured in
# isolation in section 3; this measures it through the actual crash path.
#
# The broker is killed with taskkill /F, which is the closest thing to SIGKILL: no cleanup handler
# runs, so anything that survives survived because the KERNEL did not reap it.

Get-Process msedge, bun -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 2
Say ("msedge before: " + @(Get-Process msedge -EA SilentlyContinue).Count)

# A broker in its own process, printing its socket on the first line the way `serve` does.
$serve = Start-Process -FilePath C:\orbit\bun.exe -ArgumentList "run","C:\orbit\src\src\cli.ts","serve" `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput C:\orbit\crash.out -RedirectStandardError C:\orbit\crash.err
Say ("broker pid: " + $serve.Id)

# Wait for the socket line.
$socket = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $first = (Get-Content C:\orbit\crash.out -EA SilentlyContinue | Select-Object -First 1)
  if ($first) { try { $socket = ($first | ConvertFrom-Json).socket } catch {} }
  if ($socket) { break }
}
Say ("socket: " + $(if ($socket) { "bound" } else { "NEVER PRINTED" }))

if ($socket) {
  $driver = @"
const socket = process.argv[2];
const rpc = async (method, params = {}) => {
  const r = await fetch("http://localhost/rpc", { unix: socket, method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  return await r.json();
};
const created = await rpc("session.create", { backend: "browser" });
console.log(JSON.stringify({ ok: created.ok, sessionId: created.result?.sessionId }));
"@
  Set-Content -Path C:\orbit\src\crashdrv.ts -Value $driver -Encoding UTF8
  $made = & C:\orbit\bun.exe run C:\orbit\src\crashdrv.ts $socket 2>&1 | Out-String
  Say ("session: " + $made.Trim())
  $sessionId = $null
  try { $sessionId = ($made.Trim() | ConvertFrom-Json).sessionId } catch {}

  $browsers = @(Get-Process msedge -EA SilentlyContinue)
  Say ("msedge processes with a live session: " + $browsers.Count)
  $pids = $browsers | ForEach-Object { $_.Id }

  # The abrupt death. /F is no-cleanup, so survival would mean the kernel did not reap.
  Say "killing the broker with taskkill /F, no cleanup"
  & taskkill /F /PID $serve.Id 2>&1 | Out-Null

  # How long until every browser process is gone.
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  $alive = $pids
  while ($deadline.ElapsedMilliseconds -lt 30000 -and $alive.Count -gt 0) {
    Start-Sleep -Milliseconds 200
    $alive = @($pids | Where-Object { Get-Process -Id $_ -EA SilentlyContinue })
  }
  Say ("survivors after " + [int]$deadline.ElapsedMilliseconds + "ms: " + $alive.Count)
  if ($alive.Count -gt 0) { Say ("LEAKED pids: " + ($alive -join ", ")) }
  Say ("msedge on the machine now: " + @(Get-Process msedge -EA SilentlyContinue).Count)

  # And a fresh broker must not honour the dead one's session.
  $fresh = @"
const { startBroker } = await import("C:/orbit/src/src/ipc.ts");
const b = await startBroker();
const rpc = async (method, params = {}) => {
  const r = await fetch("http://localhost/rpc", { unix: b.socket, method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  return await r.json();
};
const stale = await rpc("session.observe", { sessionId: process.argv[2] });
console.log("stale session: " + (stale.ok ? "HONOURED, which is wrong" : stale.error?.code));
const made = await rpc("session.create", { backend: "browser" });
console.log("fresh session: " + (made.ok ? made.result.state : "FAILED " + JSON.stringify(made.error)));
if (made.ok) {
  const seen = await rpc("session.observe", { sessionId: made.result.sessionId });
  console.log("fresh observe: " + (seen.ok ? seen.result.mimeType + " " + seen.result.width + "x" + seen.result.height : "FAILED"));
  await rpc("session.stop", { sessionId: made.result.sessionId });
}
await b.close();
"@
  Set-Content -Path C:\orbit\src\freshdrv.ts -Value $fresh -Encoding UTF8
  (& C:\orbit\bun.exe run C:\orbit\src\freshdrv.ts $sessionId 2>&1 | Out-String).Trim() -split "`n" | ForEach-Object { Say ("  " + $_) }
  Remove-Item C:\orbit\src\crashdrv.ts, C:\orbit\src\freshdrv.ts -Force -EA SilentlyContinue
}

Get-Process msedge, bun -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Remove-Item C:\orbit\crash.out, C:\orbit\crash.err -Force -EA SilentlyContinue
Say "done"
