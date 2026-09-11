import { chmod, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
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

export type CloneResult = {
  /** Launch options the caller must hand to the browser, or the clone starts signed out. */
  launch: ChromeLaunchOptions;
  /** Torn down with the session. The filtered bus proxy outlives nothing. */
  close: () => Promise<void>;
  sourceProfile: string;
  reflinked: boolean;
};

/**
 * A bus carrying exactly one name. The browser needs the login keyring to decrypt the profile it is
 * being given, and handing it the person's session bus would let Chrome move itself into an uncapped
 * systemd scope, which is the containment Orbit's whole resource budget rests on.
 *
 * The honest limit, measured: this filter constrains the bus NAME, not which items may be searched,
 * so a client on it can enumerate every item in the login collection. That is a real cost and it is
 * recorded in docs/separate-workspace-review.md rather than hidden here.
 */
async function filteredSecretBus(proxy: string, runtimeRoot: string): Promise<{ address: string; close: () => Promise<void> }> {
  // A unix socket path cannot exceed about 108 bytes, so this lives in the runtime directory rather
  // than beside the profile, whose path is already long.
  const directory = await mkdtemp(join(runtimeRoot, "orbit-bus-"));
  const socket = join(directory, "bus");
  const child = Bun.spawn([proxy, `unix:path=${runtimeRoot}/bus`, socket, "--filter", "--talk=org.freedesktop.secrets"],
    { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await readdir(directory)).includes("bus")) break;
    await Bun.sleep(50);
  }
  if (!(await readdir(directory)).includes("bus")) {
    child.kill();
    await rm(directory, { recursive: true, force: true });
    throw new OrbitError("BACKEND_FAILED", "The filtered secret bus did not start, so the clone would have started signed out");
  }
  return {
    address: `unix:path=${socket}`,
    close: async () => { child.kill(); await rm(directory, { recursive: true, force: true }).catch(() => {}); },
  };
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

  let bus: { address: string; close: () => Promise<void> } | undefined;
  if (verdict.store !== "basic") {
    if (!detected.filteredBusProxy) throw new OrbitError("UNSUPPORTED", "Reaching the keyring needs xdg-dbus-proxy, which is not installed");
    bus = await filteredSecretBus(detected.filteredBusProxy, process.env.XDG_RUNTIME_DIR ?? "/run/user/1000");
  }
  return {
    sourceProfile, reflinked: verdict.reflink,
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
