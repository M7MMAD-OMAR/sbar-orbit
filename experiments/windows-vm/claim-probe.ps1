$ErrorActionPreference = 'Continue'
$Tree = 'C:\orbit\w0918c\sbar-orbit-0.1.0-alpha.6-source'
Set-Location $Tree

# `claiming refuses a live broker and clears only a dead socket` fails here. The test binds a real
# server, then expects a STALE socket file (server stopped) to be removable. My change added an
# emptiness probe before unlinking, and on Windows reading a socket file may not behave like reading
# an empty file at all. This asks what `stat` and a read actually answer, live and stale.
$Probe = @'
import { statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "claim-probe-"));
const socket = join(root, "broker.sock");
const server = Bun.serve({ unix: socket, fetch: () => new Response("ok") });

const ask = async (label) => {
  let shape = "";
  try { const s = statSync(socket); shape = `size=${s.size} isSocket=${s.isSocket()} isFile=${s.isFile()}`; }
  catch (e) { shape = "stat threw " + e.code; }
  let read = "";
  try { const b = await Bun.file(socket).arrayBuffer(); read = "read ok, bytes=" + b.byteLength; }
  catch (e) { read = "read threw " + (e.code ?? e.name) + " :: " + e.message.slice(0, 80); }
  console.log(label + "\n  " + shape + "\n  " + read);
};

await ask("LIVE (server bound)");
server.stop(true);
await Bun.sleep(300);
console.log("after stop, file still present: " + (await Bun.file(socket).exists()));
await ask("STALE (server stopped)");
'@
Set-Content -Path 'C:\orbit\claim-probe.mjs' -Value $Probe -Encoding utf8
& C:\orbit\bun.exe C:\orbit\claim-probe.mjs 2>&1 | Out-String | ForEach-Object { Say $_ }
Say "DONE"
