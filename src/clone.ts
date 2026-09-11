import { chmod, cp, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OrbitError } from "./errors";
import { canCloneProfile, detectPlatform, stripSingletonMarkers, type PlatformCapabilities } from "./platform";
import { requireBoundedOrigins, type SessionPolicy } from "./policy";
import type { ChromeLaunchOptions } from "./chrome";

/**
 * Giving an agent the person's real logged in sessions, by copying their browser profile.
 *
 * What makes this safe enough to exist is that it is a COPY. The agent works on a reflinked clone
 * that is deleted when the session stops, so nothing it does reaches the person's own browser: no
 * cookie it sets, no site it signs out of, no setting it changes. Local state is therefore reversible
 * by construction rather than by an undo mechanism, and that is the only reversibility a browser
 * agent can honestly claim. What it does on a remote service is not reversible by anything local,
 * which is why the policy and its origin allowlist carry the rest of the weight.
 *
 * Measured on the owner's workstation: a 5.25 GiB Chrome profile copies in 620 ms at zero exclusive
 * bytes, and 142 of 142 cookies decrypt in the clone.
 */

/**
 * Paths inside the clone the session may read and not rewrite, borrowed from Codex's read only
 * subpaths inside a writable root. The clone is the session's to change, but these four decide what
 * the browser itself is: its settings, its content permissions, the key wrapper and the extension
 * set. A session that can rewrite them can widen itself by editing the thing that was supposed to
 * bound it.
 *
 * Two limits, both stated plainly, because a guard that is oversold is worse than none.
 *
 * This is a file mode on files the same user owns. It stops the browser writing them in the ordinary
 * course. It is not containment against a program that decides to change them back.
 *
 * Only files are frozen, never the directories holding them. A read only directory cannot have its
 * entries unlinked, and the session profile is deleted when the session stops, so freezing a
 * directory would trade "an extension could be added" for "a copy of the person's live cookies
 * cannot be removed". That is the worse of the two, and the tests that found it are in place.
 */
export const readOnlyProfilePaths = ["Preferences", "Secure Preferences", "Local State", "Extensions"];

export type CloneResult = {
  /** Launch options the caller must hand to the browser, or the clone starts signed out. */
  launch: ChromeLaunchOptions;
  /** Torn down with the session. The filtered bus proxy outlives nothing. */
  close: () => Promise<void>;
  sourceProfile: string;
  reflinked: boolean;
  /** Which of the read only paths were present and were frozen. */
  readOnly: string[];
};

/**
 * A bus carrying exactly one secret.
 *
 * The browser needs the login keyring to decrypt the profile it is being given. Two narrower things
 * than the person's session bus were measured, and they are not equivalent. A filtering proxy
 * (`xdg-dbus-proxy --filter --talk=org.freedesktop.secrets`) constrains the bus NAME but not which
 * items may be searched, and a client on one enumerated all 25 items in the login collection to
 * reach a single key. A private bus serving one item reached the same decryption, a share of 1.0
 * over 142 cookies, with exactly 1 item enumerable. Both blocked `org.freedesktop.systemd1`, the
 * route Chrome uses to move itself out of Orbit's resource scope.
 *
 * So this takes the second. The broker reads one item from the real keyring, and the browser sees
 * only that. The cost that remains, stated rather than hidden: a helper process holds one real
 * secret in memory for the life of the session.
 */
async function oneItemSecretBus(application: string, label: string): Promise<{ address: string; close: () => Promise<void> }> {
  const child = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "native/one_secret.py"),
    JSON.stringify({ application }), label], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const announced = await Promise.race([
    (async () => {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      return new TextDecoder().decode(value ?? new Uint8Array()).trim();
    })(),
    Bun.sleep(15000).then(() => ""),
  ]);
  const close = async () => { child.stdin.end(); child.kill(); await child.exited.catch(() => {}); };
  if (!announced.startsWith("{")) {
    await close();
    throw new OrbitError("BACKEND_FAILED", "The one-item secret bus did not start, so the clone would have started signed out");
  }
  return { address: (JSON.parse(announced) as { address: string }).address, close };
}

/**
 * Prepare a session profile from the person's own. The policy is required and must name its origins:
 * a session holding real logins with an unbounded origin set is the case the policy exists to
 * prevent, so the refusal happens here, before anything is copied.
 */
export async function cloneProfile(
  sourceProfile: string, sessionProfile: string, policy: SessionPolicy,
  capabilities?: PlatformCapabilities,
): Promise<CloneResult> {
  requireBoundedOrigins(policy);
  const detected = capabilities ?? await detectPlatform();
  const verdict = await canCloneProfile(sourceProfile, detected, sessionProfile);
  if (!verdict.allowed) throw new OrbitError("UNSUPPORTED", verdict.reason);

  // The session profile already exists as an empty directory, so the copy replaces it rather than
  // landing one level deeper than the launcher expects.
  await rm(sessionProfile, { recursive: true, force: true });
  await cp(sourceProfile, sessionProfile, { recursive: true, dereference: false, force: true });
  // A copy inherits the source's permissions, and a browser profile is commonly 0755. That is the
  // person's own choice for their own directory; it is not acceptable for a copy of their live
  // logins sitting in a workspace, so the clone is tightened rather than inherited. Orbit's process
  // supervisor independently refuses to start under a group or world readable profile, which is how
  // this was caught.
  await chmod(sessionProfile, 0o700);
  // A copy taken from a running browser carries its locks. Chrome then refuses to start, and has been
  // observed asking a desktop dialog to resolve it, which would put a window on the person's screen.
  await stripSingletonMarkers(sessionProfile);
  const frozen: string[] = [];
  const freeze = async (path: string, relative: string) => {
    let entry: Awaited<ReturnType<typeof stat>>;
    try { entry = await stat(path); } catch { return }   // never had it, so nothing is unprotected
    if (entry.isFile()) { await chmod(path, 0o400); frozen.push(relative); return }
    if (!entry.isDirectory()) return;
    // Into the directory, not the directory itself: see the note above on why.
    for (const child of await readdir(path, { withFileTypes: true }))
      await freeze(join(path, child.name), relative);
    if (!frozen.includes(relative)) frozen.push(relative);
  };
  for (const relative of readOnlyProfilePaths)
    for (const path of [join(sessionProfile, relative), join(sessionProfile, "Default", relative)])
      await freeze(path, relative);

  let bus: { address: string; close: () => Promise<void> } | undefined;
  if (verdict.store !== "basic")
    bus = await oneItemSecretBus(verdict.install.keyringApplication, verdict.install.keyringItem);
  return {
    sourceProfile, reflinked: verdict.reflink, readOnly: frozen,
    launch: {
      // The install that owns the profile, because the keyring item is named after its branding and
      // another browser looks up a different one and decrypts nothing.
      executable: verdict.install.executable,
      passwordStore: verdict.store,
      ...(bus ? { sessionBus: bus.address } : {}),
      // The person's own extensions are part of what they asked for. Chrome's launcher disables them
      // by default, which leaves them present in the profile and dormant.
      extensions: true,
    },
    close: async () => { await bus?.close(); },
  };
}
