$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918\sbar-orbit-0.1.0-alpha.6-source'
Set-Location $Tree

# The harness serves a fake broker on an AF_UNIX socket at a FILESYSTEM path and then spawns the CLI
# to speak to it. docs/windows-measured.md section 2 measured `Bun.serve({unix})` serving there and a
# POST through `fetch(..., {unix})` returning the body, but that was one process talking to itself.
# This asks the question the harness actually asks: does a SEPARATE process reach that socket?
$Probe = @'
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sock-probe-"));
const socket = join(root, "broker.sock");
let served = 0;
const server = Bun.serve({ unix: socket, async fetch(request) {
  served++;
  const { method } = await request.json();
  return Response.json({ ok: true, result: method === "session.list" ? [] : null });
} });
console.log("bound at: " + socket);

// Same process first, which is what section 2 measured.
try {
  const own = await fetch("http://localhost/rpc", { unix: socket, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "session.list" }),
    signal: AbortSignal.timeout(5000) });
  console.log("same process:     " + JSON.stringify(await own.json()));
} catch (error) { console.log("same process:     FAILED " + error.message); }

// Then a separate process, which is what the failing tests do.
const child = spawn(process.execPath, ["src/cli.ts", "session", "list"],
  { env: { ...process.env, ORBIT_SOCKET: socket, ORBIT_USAGE_DIR: join(root, "usage"), ORBIT_CONVERSATION_ID: "probe" } });
let out = "", err = "";
child.stdout.on("data", d => out += d);
child.stderr.on("data", d => err += d);
const started = Date.now();
const result = await new Promise(resolve => {
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("TIMED OUT after 8s"); }, 8000);
  child.on("exit", code => { clearTimeout(timer); resolve("exit " + code); });
});
console.log("separate process: " + result + " in " + (Date.now() - started) + "ms");
console.log("  stdout: " + out.trim());
console.log("  stderr: " + err.trim());
console.log("requests the server saw: " + served);
server.stop(true);
'@
Set-Content -Path 'C:\orbit\sock-probe.mjs' -Value $Probe -Encoding utf8
& C:\orbit\bun.exe C:\orbit\sock-probe.mjs 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "DONE"
