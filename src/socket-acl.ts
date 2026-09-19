import { OrbitError } from "./errors";

/**
 * Restrict the broker socket to its owner, on Windows, by writing a DACL.
 *
 * `chmod(socket, 0o600)` is what the code did and it is not enough here. Measured on a Windows 11
 * guest, against the real `Bun.serve({ unix })` socket, read WHILE it was bound (Bun unlinks it on
 * stop, so a probe that looks afterwards finds nothing and reads as "no socket" rather than as a
 * measurement):
 *
 *     chmod(0o600): returned without throwing
 *     attributes:   Archive, ReparsePoint
 *     owner:        BUILTIN\Administrators
 *     ACE: BUILTIN\Administrators            | FullControl          | inherited=True
 *     ACE: NT AUTHORITY\SYSTEM               | FullControl          | inherited=True
 *     ACE: BUILTIN\Users                     | ReadAndExecute       | inherited=True
 *     ACE: NT AUTHORITY\Authenticated Users  | Modify, Synchronize  | inherited=True
 *
 * So `chmod` succeeds, changes nothing that matters, and the socket keeps the parent's inherited ACL.
 * That is not an abstract weakness: on a directory under a drive root, `Authenticated Users` had
 * `Modify` and `BUILTIN\Users` had read. Any account on the machine could reach the control channel,
 * which accepts `session.create`, `session.act`, `session.observe` and the rest with no caller
 * authentication.
 *
 * It is conditional on where the socket binds, which is why it was worth measuring both ends rather
 * than assuming the worse one. A MANAGED broker binds under `%LOCALAPPDATA%`, measured on the same
 * guest as SYSTEM, Administrators and the owning user only, with no Everyone and no Users. An
 * unmanaged broker binds under `mkdtemp(tmpdir())`, and `TMP` is whatever the environment says, so it
 * can be a drive-root directory with exactly the ACL above. Relying on the caller's `TMP` to be
 * private is the kind of assumption this project is supposed to refuse.
 *
 * The fix states the DACL rather than inheriting one: inheritance off, every inherited entry dropped,
 * one entry for the owning user. `icacls` is used because it is in System32 on every Windows install
 * and needs no elevation to rewrite the DACL of a file you own.
 */
export async function restrictSocketToOwner(socket: string): Promise<void> {
  if (process.platform !== "win32") return;
  const system32 = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  // Absolute, never through PATH, for the same reason the registry probe is: this decides the access
  // control of the control channel, and letting the agent host's PATH choose the program that sets it
  // would hand that decision to whatever exported PATH.
  const icacls = `${system32}\\System32\\icacls.exe`;
  const user = process.env.USERNAME;
  // Without a user name there is nobody to grant to, and granting to a guess would be worse than
  // leaving the inherited ACL in place and saying so.
  if (!user) throw new OrbitError("SOCKET_UNPROTECTED", "Cannot restrict the broker socket: USERNAME is unset");

  // `/inheritance:r` removes the inherited entries rather than merely adding one on top of them: an
  // extra grant next to `Authenticated Users: Modify` protects nothing.
  const applied = Bun.spawnSync([icacls, socket, "/inheritance:r", "/grant:r", `${user}:(F)`]);
  if (applied.exitCode !== 0) {
    const detail = `${applied.stdout.toString()} ${applied.stderr.toString()}`.trim().split("\n")[0] ?? "";
    throw new OrbitError("SOCKET_UNPROTECTED", `Cannot restrict the broker socket to this user: ${detail}`);
  }

  // Verified, not assumed. `icacls` reports success in cases where the result is not what was asked
  // for, and a control channel whose protection was never checked is a control channel that is
  // protected until the first time it is not.
  // PowerShell 7 hosts export module paths that Windows PowerShell 5 cannot load.
  // Let the fixed system executable discover its own modules in this child only.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const listed = Bun.spawnSync([`${system32}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath '${socket.replace(/'/g, "''")}').Access | ForEach-Object { "$($_.IdentityReference)" }`], { env });
  const principals = listed.stdout.toString().trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // An empty read means the probe failed, not that the socket is private. Passing on an empty result
  // is how this check would quietly stop guarding anything, which is the mistake `tests/private-path.ts`
  // already calls out for the diagnostics files.
  if (listed.exitCode !== 0 || principals.length === 0)
    throw new OrbitError("SOCKET_UNPROTECTED", "Cannot read the broker socket's ACL to confirm it is private");
  const exposed = principals.filter(name =>
    /Everyone|ANONYMOUS LOGON|\\Users$|INTERACTIVE|Authenticated Users|Guests/i.test(name));
  if (exposed.length > 0)
    throw new OrbitError("SOCKET_UNPROTECTED", `The broker socket is reachable by ${exposed.join(", ")}`);
}
