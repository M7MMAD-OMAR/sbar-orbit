/**
 * Follow up on the transport finding: `Bun.serve({unix})` serves on a Windows FILESYSTEM path, so
 * the broker's RPC layer needs no rewrite. What is left is the question a named pipe was chosen to
 * answer in the first place, which is authentication.
 *
 * AF_UNIX on Windows carries no ancillary data, so there is no peer credential to read. Microsoft's
 * own position is that the filesystem ACL is the access control. So the thing to measure is the ACL
 * the socket file actually gets, and whether tightening it is reachable from Bun.
 */

import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const results: Record<string, unknown> = {};

function sddl(path: string): string {
  const proc = Bun.spawnSync([
    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    `(Get-Acl -LiteralPath '${path}').Sddl`,
  ]);
  return proc.stdout.toString().trim() || `unreadable: ${proc.stderr.toString().trim().slice(0, 160)}`;
}

// The broker's real location on Windows would be under LOCALAPPDATA, which is per user and
// non roaming, rather than a world writable temp directory.
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const root = mkdtempSync(join(localAppData, "orbit-sock-"));
const socketPath = join(root, "broker.sock");

results.socketRoot = root.replace(localAppData, "%LOCALAPPDATA%");
results.rootSddl = sddl(root);

const server = Bun.serve({
  unix: socketPath,
  fetch: async request => Response.json({ ok: true, method: (await request.json() as { method?: string }).method ?? null }),
});

// Does a socket file exist on disk at all, and what is it.
// Measured: `statSync` on a Windows AF_UNIX socket path throws EACCES while the server is listening,
// so existence and the ACL are read without stat. That matters for `claimSocket()`, which decides a
// leftover path's fate from `stat().isSocket()` on Linux and cannot do so here.
results.socketFileExists = existsSync(socketPath);
try {
  const info = statSync(socketPath);
  results.socketFileMode = "0o" + (info.mode & 0o777).toString(8);
  results.socketFileSize = info.size;
} catch (error) {
  results.socketStat = `refused: ${(error as Error).message.slice(0, 120)}`;
}
if (existsSync(socketPath)) {
  results.socketSddl = sddl(socketPath);
} else {
  // A Windows AF_UNIX socket is an NTFS reparse point, so it should be visible. If it is not, the
  // ACL story has nowhere to attach and the token file becomes the only authentication.
  results.socketSddl = "no file to read an ACL from";
}

// A real round trip through the same call shape src/ipc.ts uses.
try {
  const response = await fetch("http://localhost/rpc", {
    unix: socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "doctor" }),
  });
  results.roundTrip = await response.json();
} catch (error) {
  results.roundTrip = `failed: ${(error as Error).message.slice(0, 200)}`;
}

// Can the process tighten the ACL itself, with no native code: strip inheritance and leave only the
// owning user. This is the Windows analogue of the mode 0600 the Linux broker applies.
const tighten = Bun.spawnSync([
  "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
  `$p='${root}'; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); ` +
  `$a.Access | ForEach-Object { [void]$a.RemoveAccessRule($_) }; ` +
  `$me=[Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
  `$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); ` +
  `Set-Acl -LiteralPath $p -AclObject $a; (Get-Acl -LiteralPath $p).Sddl`,
]);
results.tightenedRootSddl = tighten.stdout.toString().trim() || `failed: ${tighten.stderr.toString().trim().slice(0, 200)}`;

// Still serving after the ACL change, which is the part that would break if it were done wrong.
try {
  const response = await fetch("http://localhost/rpc", { unix: socketPath, method: "POST", body: JSON.stringify({ method: "after-acl" }) });
  results.roundTripAfterTightening = await response.json();
} catch (error) {
  results.roundTripAfterTightening = `failed: ${(error as Error).message.slice(0, 200)}`;
}

// Is the stale socket case recoverable, the way claimSocket() needs it to be? Windows keeps the
// reparse point after the server stops, and a rebind on a leftover path is what a broker restart does.
server.stop(true);
results.fileAfterStop = existsSync(socketPath);
try {
  const again = Bun.serve({ unix: socketPath, fetch: () => new Response("second") });
  results.rebindOverStaleSocket = "bound";
  again.stop(true);
} catch (error) {
  results.rebindOverStaleSocket = `refused: ${(error as Error).message.slice(0, 200)}`;
}

rmSync(root, { recursive: true, force: true });
results.bunVersion = Bun.version;
console.log(JSON.stringify(results, null, 2));
