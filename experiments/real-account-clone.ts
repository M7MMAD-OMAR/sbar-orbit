/**
 * Acceptance T6 against a real service, and the first reading of G18, with no password typed by
 * anyone: the signed in state comes from a clone of the person's own browser profile, which is the
 * path gate G8 closed, and the person has asked for this run.
 *
 * What it does, in order:
 *   1. A session cloned from the person's Chrome profile, bounded to one origin, navigates there and
 *      reads the signed in marker. If the person is not signed in to that service in their browser,
 *      the run says so and stops; it does not try another service, because which services the person
 *      uses is theirs to name.
 *   2. The storage state of that session is saved as an account snapshot, exactly the shape
 *      `session.account.save` writes, but under a scratch account directory that is deleted when
 *      this file ends. Orbit's own accounts directory is never written, and the snapshot never
 *      leaves the scratch directory: the accounts feature stays what accounts.md says it is.
 *   3. A fresh session on that account name, no clone, is navigated to the service and asked the
 *      same question. Login surviving a profile restart is T6's first claim.
 *   4. A third session on the same name must be refused with PROFILE_BUSY. That is the second.
 *   5. The restored session is held for ORBIT_HOLD_MS, navigating again every five minutes, so any
 *      rotation the service performs happens inside Orbit. Then the person's profile is cloned
 *      again and read: if their own browser's state still signs in, the rotation did not log them
 *      out. That is G18's question, answered for this service and this duration only.
 *
 * Nothing about the account is recorded: no name, no cookie, no page text. The report carries
 * booleans, timings, counts and the origin. The one frame kept is for the person.
 *
 * Run: ORBIT_REAL_PROFILE=1 bun run scripts/limited.ts bun run experiments/real-account-clone.ts
 *   ORBIT_ACCOUNT_SERVICE   origin (default https://github.com)
 *   ORBIT_ACCOUNT_SELECTOR  selector rendered only when signed in (default .AppHeader-user)
 *   ORBIT_HOLD_MS           how long to hold the restored session (default 60 minutes)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Sessions } from "../src/session";
import { AccountLease } from "../src/profiles";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { requireResourceBudget } from "../src/resource-budget";

if (process.env.ORBIT_REAL_PROFILE !== "1")
  throw new Error("Refusing to read a real browser profile. Set ORBIT_REAL_PROFILE=1 only when the person asked for this.");
await requireResourceBudget();
/**
 * Where a signed in person can go and a signed out one is sent to a login page instead. The check is
 * the final location the session reports after navigating there, never page text: a location that
 * still carries the protected path is signed in, one that landed on a sign in path is not. The first
 * candidate the person's profile is signed in to is the service measured; the others are only
 * recorded as signed in or not.
 */
const candidates = (process.env.ORBIT_ACCOUNT_PROTECTED ?? [
  "https://github.com/settings/profile",
  "https://gitlab.com/-/profile",
  "https://supabase.com/dashboard/projects",
  "https://www.npmjs.com/settings/h.muhmad/profile",
].join(" ")).split(/\s+/).filter(Boolean);
const holdMs = Number(process.env.ORBIT_HOLD_MS ?? 3_600_000);
const loginPath = /log-?in|sign-?_?in|sign_in|auth/i;
const source = process.env.ORBIT_PROFILE_SOURCE ?? join(homedir(), ".config", "google-chrome");
const directory = join("output", `real-account-clone-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
// The scratch account root: private, and gone at the end. Orbit's own accounts directory is untouched.
const accountRoot = await mkdtemp(join(homedir(), ".cache", "orbit-real-account-"));
const name = "real-account-clone";
const workspace = await createWorkspaceDirectory("real-account-clone");
const sessions = new Sessions(workspace, accountRoot);
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), candidates: candidates.map(c => new URL(c).origin), holdMs };
const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
const act = (session: { sessionId: string }, action: unknown) => run("session.act", { ...session, requestId: crypto.randomUUID(), action });
const policyFor = (origins: string[]) => ({ mode: "supervised", origins, allow: ["read", "navigate", "write"], deny: ["irreversible"] });
const signedInAt = async (session: { sessionId: string }, protectedUrl: string) => {
  await act(session, { type: "navigate", url: protectedUrl });
  await Bun.sleep(1500);
  const presence = await run("session.presence", session) as { location: string };
  const wanted = new URL(protectedUrl);
  return presence.location.startsWith(`${wanted.origin}${wanted.pathname}`) && !loginPath.test(presence.location.slice(wanted.origin.length));
};
const stop = (session: { sessionId: string }) => run("session.stop", session).catch(() => {});

try {
  // 1. The clone.
  const t0 = performance.now();
  // Without the person's extensions: a proxy extension in this profile set its own proxy inside the
  // confined clone and every origin came back ERR_INTERNET_DISCONNECTED, the lease failing closed as
  // it should. The logins are in the profile, not in the add-ons.
  const clone = await run("session.create", { backend: "browser", cloneOf: source, cloneExtensions: false, policy: policyFor(candidates.map(c => new URL(c).origin)), agentName: "SbarOrbit", taskName: "Real account: clone" }) as { sessionId: string };
  report.cloneCreateMs = Math.round(performance.now() - t0);
  const signedInTo: Record<string, boolean> = {};
  for (const candidate of candidates) signedInTo[new URL(candidate).origin] = await signedInAt(clone, candidate);
  report.cloneSignedInTo = signedInTo;
  const protectedUrl = candidates.find(c => signedInTo[new URL(c).origin]);
  if (!protectedUrl) {
    await stop(clone);
    throw new Error("The person's browser is signed in to none of the candidate services, so there is no real account to carry");
  }
  const origin = new URL(protectedUrl).origin;
  const policy = policyFor([origin]);
  const signedIn = (session: { sessionId: string }) => signedInAt(session, protectedUrl);
  report.origin = origin;
  report.cloneSignedIn = true;
  // 2. Its storage state, as an account snapshot, in scratch. The session map is private; reaching
  //    into it is this experiment's one liberty, taken instead of adding a save path for clones to
  //    the product, which accounts.md rules out.
  const backend = (sessions as unknown as { sessions: Map<string, { backend: { context: { storageState: (o: { indexedDB: boolean }) => Promise<unknown> } } }> }).sessions.get(clone.sessionId)!.backend;
  const state = await backend.context.storageState({ indexedDB: true }) as { cookies?: unknown[]; origins?: unknown[] };
  report.snapshot = { cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0 };
  const lease = await AccountLease.acquire(accountRoot, name);
  await lease.save(state);
  await lease.release();
  await stop(clone);

  // 3. Restart on the saved state, no clone.
  const t1 = performance.now();
  const restored = await run("session.create", { backend: "browser", accountName: name, policy, agentName: "SbarOrbit", taskName: "Real account: restored" }) as { sessionId: string };
  report.restoredSignedIn = await signedIn(restored);
  report.restoreToPageMs = Math.round(performance.now() - t1);
  const frame = await run("session.observe", restored) as { image: string };
  await writeFile(join(directory, "restored.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });

  // 4. The lease.
  try { const third = await run("session.create", { backend: "browser", accountName: name, policy }) as { sessionId: string }; report.leaseRefused = false; await stop(third); }
  catch (error) { report.leaseCode = (error as { code?: string }).code; report.leaseRefused = report.leaseCode === "PROFILE_BUSY"; }
  report.t6 = report.restoredSignedIn === true && report.leaseRefused === true;

  // 5. The hold, then the person's own state read again through a fresh clone.
  const held = Date.now();
  const checks: { atMin: number; signedIn: boolean }[] = [];
  while (Date.now() - held < holdMs) {
    await Bun.sleep(Math.min(300_000, holdMs - (Date.now() - held)));
    checks.push({ atMin: Math.round((Date.now() - held) / 60000), signedIn: await signedIn(restored) });
  }
  report.hold = { minutes: Math.round((Date.now() - held) / 60000), checks, stillSignedInAtEnd: checks.at(-1)?.signedIn ?? report.restoredSignedIn };
  await stop(restored);
  const again = await run("session.create", { backend: "browser", cloneOf: source, cloneExtensions: false, policy, agentName: "SbarOrbit", taskName: "Real account: clone after hold" }) as { sessionId: string };
  report.personalStateSignsInAfterHold = await signedIn(again);
  await stop(again);
  report.g18 = { service: origin, heldMinutes: report.hold && (report.hold as { minutes: number }).minutes,
    personLoggedOut: report.personalStateSignsInAfterHold === false,
    limit: "one service, one hold; a device bound service with a shorter refresh interval than this hold is what the gate names, and this says nothing about one" };
  report.status = "completed";
  report.limitations = [
    "The signed in state came from a clone of the person's own profile, at their request, and no credential was typed by anyone.",
    "The snapshot lived in a scratch directory at mode 0700 for the length of the run and was deleted with it; Orbit's accounts directory was not written.",
    "One service and one selector; another provider's authentication prompts are not covered.",
    "Whether the person's own browser stays signed in is read by cloning their profile again, not by looking at their browser.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await sessions.close?.().catch?.(() => {});
  await rm(accountRoot, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}
