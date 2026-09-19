import { test, expect } from "bun:test";
import { restrictSocketToOwner } from "../src/socket-acl";
import { startBroker } from "../src/ipc";
import { OrbitError } from "../src/errors";

/**
 * The broker socket is private because its DACL says so, not because a mode was passed.
 *
 * `chmod(socket, 0o600)` was the whole protection. Measured on a Windows 11 guest against the real
 * `Bun.serve({ unix })` socket, read while it was still bound:
 *
 *     chmod(0o600): returned without throwing
 *     attributes:   Archive, ReparsePoint
 *     owner:        BUILTIN\Administrators
 *     ACE: BUILTIN\Administrators            | FullControl          | inherited=True
 *     ACE: NT AUTHORITY\SYSTEM               | FullControl          | inherited=True
 *     ACE: BUILTIN\Users                     | ReadAndExecute       | inherited=True
 *     ACE: NT AUTHORITY\Authenticated Users  | Modify, Synchronize  | inherited=True
 *
 * `chmod` succeeded and changed nothing that matters. Whether that is an exposure depends on where the
 * socket binds: `%LOCALAPPDATA%` was measured on the same guest as SYSTEM, Administrators and the
 * owning user only, while the drive-root directory above hands down Authenticated Users with Modify.
 * An unmanaged broker binds under `mkdtemp(tmpdir())`, and `TMP` is whatever the environment says.
 *
 * Behind that socket the control channel takes session.create, session.act and session.observe with no
 * caller authentication, so "whoever can open the file" is the entire boundary.
 */

const windowsOnly = process.platform !== "win32";

test.skipIf(windowsOnly)("a bound broker socket is reachable by its owner and nobody else", async () => {
  const broker = await startBroker({});
  try {
    const listed = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
      `(Get-Acl -LiteralPath '${broker.socket}').Access | ForEach-Object { "$($_.IdentityReference)" }`]);
    const principals = listed.stdout.toString().trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    // An empty read is a failed probe, not a private socket. Asserting on an empty list is how this
    // check would quietly stop guarding anything.
    expect(principals.length).toBeGreaterThan(0);
    const exposed = principals.filter(name =>
      /Everyone|ANONYMOUS LOGON|\\Users$|INTERACTIVE|Authenticated Users|Guests/i.test(name));
    expect(exposed).toEqual([]);
    // And the broker still answers after its DACL was rewritten, which is the half a permissions fix
    // most easily breaks: a socket nobody can reach is private and useless.
    const { call } = await import("../src/ipc");
    expect(await call(broker.socket, "doctor")).toBeDefined();
  } finally {
    await broker.close();
  }
}, 30000);

test.skipIf(windowsOnly)("a socket that cannot be made private is refused rather than served", () => {
  // A path that does not exist cannot have its DACL set, and the answer is to throw rather than to
  // carry on with an inherited ACL and call it protected.
  expect(() => restrictSocketToOwner("C:\\orbit\\definitely-not-here\\broker.sock")).toThrow(OrbitError);
});

test.skipIf(!windowsOnly)("on POSIX the mode is the protection and no ACL work is done", () => {
  // The function is a no-op off Windows: POSIX stores the mode `chmod` passes, so there is nothing to
  // repair, and shelling out to icacls there would be nonsense. A path that does not exist is fine.
  expect(() => restrictSocketToOwner("/tmp/not-a-real-socket-path/broker.sock")).not.toThrow();
});
