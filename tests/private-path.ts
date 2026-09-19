import { expect } from "bun:test";
import { stat } from "node:fs/promises";

/**
 * Assert that a path holding a person's data is private, in the terms the running kernel uses.
 *
 * POSIX stores the mode Orbit passes to `mkdir` and `writeFile`, so there the assertion is the mode
 * itself. Windows ignores that argument completely: `stat` reports 438 for a file Orbit asked to be
 * 0o600, and asserting the number would be asserting something the kernel never stored. That is why
 * these tests failed on the guest, and reading the failure as "a POSIX file mode test" was the easy
 * mistake: the SUBJECT is not the number, it is that nobody else can read the file.
 *
 * On Windows that property lives in the ACL, so it is checked there instead. Measured on a Windows 11
 * guest, a diagnostics file written by the real code inherits exactly three entries, SYSTEM,
 * BUILTIN\Administrators and the owning user, with no Everyone and no Anonymous, which is the same
 * set the broker socket inherits. See docs/windows-measured.md section 16.
 */
export async function expectPrivatePath(path: string, posixMode: number) {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(posixMode);
    return;
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const listed = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
    `(Get-Acl -LiteralPath '${path}').Access | ForEach-Object { "$($_.IdentityReference)" }`], { env });
  expect(listed.exitCode).toBe(0);
  const principals = listed.stdout.toString().trim().split(/\r?\n/).map(entry => entry.trim()).filter(Boolean);
  // The ACL has to say something. An empty read means the probe failed, not that the file is private,
  // and passing on an empty result is how this check would quietly stop guarding anything.
  expect(principals.length).toBeGreaterThan(0);
  const exposed = principals.filter(name =>
    /Everyone|ANONYMOUS LOGON|\\Users$|INTERACTIVE|Authenticated Users|Guests/i.test(name));
  expect(exposed).toEqual([]);
}
