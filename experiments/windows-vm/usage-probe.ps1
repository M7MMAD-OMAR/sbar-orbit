$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918\sbar-orbit-0.1.0-alpha.6-source'
Set-Location $Tree

# The two failing agent-interface tests time out at 5000ms. The harness spawns the CLI and parses its
# stdout; a "JSON Parse error: Unexpected EOF" means the CLI produced nothing on the stream the test
# read. This asks what the CLI actually does on this platform, one call at a time, with a hard clock
# on each so a hang is visible as a hang rather than as a suite timeout.
$Probe = @'
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "usage-probe-"));
const bun = process.execPath;

function run(args, env, label) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(bun, ["src/cli.ts", ...args], { env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ label, timedOut: true, ms: Date.now() - started, out, err }); }, 8000);
    child.on("exit", code => { clearTimeout(timer); resolve({ label, code, ms: Date.now() - started, out: out.trim(), err: err.trim() }); });
  });
}

const env = { ORBIT_USAGE_DIR: join(root, "usage"), ORBIT_SOCKET: join(root, "absent.sock") };
for (const [label, args, extra] of [
  ["usage status, id in env",  ["usage", "status"], { ORBIT_CONVERSATION_ID: "probe-a" }],
  ["usage on, id in env",      ["usage", "on"],     { ORBIT_CONVERSATION_ID: "probe-a" }],
  ["usage off, id positional", ["usage", "off", "probe-b"], {}],
  ["usage off, no id",         ["usage", "off"],    {}],
  ["session list, id in env",  ["session", "list"], { ORBIT_CONVERSATION_ID: "probe-a" }],
]) {
  const r = await run(args, { ...env, ...extra }, label);
  console.log(JSON.stringify(r));
}
'@
Set-Content -Path 'C:\orbit\usage-probe.mjs' -Value $Probe -Encoding utf8
& C:\orbit\bun.exe C:\orbit\usage-probe.mjs 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "DONE"
