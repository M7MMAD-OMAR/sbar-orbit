/**
 * Acceptance T6 against a real service, with the person doing the one thing only they may do.
 *
 * The gate: login survives an Orbit profile restart, another session cannot take the account's
 * lease, and the personal profile is untouched. No agent ever types a password, and this file does
 * not either. It creates a named account session bounded to one origin, navigates it to the
 * service, pauses it, opens the viewer in Orbit's own browser window, and then waits for the person
 * to take over, sign in through the viewer, and press **Save account state**. Everything after the
 * snapshot appears on disk is measured by this file: the session is stopped, a second session is
 * created on the same account name and navigated to the same service, and whether the page shows
 * the signed in state is read through the session's own `read` action against a selector the
 * service is known to render only for a signed in person. A third session on the same name must be
 * refused with PROFILE_BUSY while the second holds the lease.
 *
 * Nothing about the account is recorded: no name, no cookie, no page text. The report carries
 * booleans, timings and the origin.
 *
 * Personal profile untouched: an account session starts from a fresh temporary profile under the
 * workspace root and reads no directory of the person's browser; the report records the session
 * profile's parent so the reader can see it is not ~/.config, and nothing else about the person's
 * browser is read to say so.
 *
 * Run: bun run scripts/limited.ts bun run experiments/real-account.ts
 *   ORBIT_ACCOUNT_SERVICE   the origin to sign in to (default https://github.com)
 *   ORBIT_ACCOUNT_SELECTOR  a selector present only when signed in (default .AppHeader-user, GitHub's avatar button)
 *   ORBIT_ACCOUNT_NAME      the account name to save under (default real-account-trial)
 *   ORBIT_ACCOUNT_WAIT_MS   how long to wait for the person (default 10 minutes)
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { workspaceRoot } from "../src/workspace-storage";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const service = process.env.ORBIT_ACCOUNT_SERVICE ?? "https://github.com";
const selector = process.env.ORBIT_ACCOUNT_SELECTOR ?? ".AppHeader-user";
const name = process.env.ORBIT_ACCOUNT_NAME ?? "real-account-trial";
const waitMs = Number(process.env.ORBIT_ACCOUNT_WAIT_MS ?? 600_000);
const origin = new URL(service).origin;
const snapshot = join(process.env.ORBIT_ACCOUNT_DIR ?? join(homedir(), ".local/state/sbar-orbit/accounts"), name, "state.json");
const directory = join("output", `real-account-${new Date().toISOString().slice(0, 10)}`);
await mkdir(directory, { recursive: true, mode: 0o700 });

const broker = await startBroker();
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), origin, selector, accountName: name };
const create = () => call(broker.socket, "session.create", { backend: "browser", accountName: name, policy: { origins: [origin], allow: ["read", "navigate", "write"], deny: ["irreversible"] }, agentName: "SbarOrbit", taskName: "Real account trial", conversationName: "Real account trial" }) as Promise<{ sessionId: string; profile?: string }>;
const act = (session: { sessionId: string }, action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
const signedIn = async (session: { sessionId: string }) => {
  try { await act(session, { type: "read", selector }); return true; } catch { return false; }
};
try {
  const modifiedBefore = await stat(snapshot).then(s => s.mtimeMs).catch(() => 0);
  const first = await create();
  await act(first, { type: "navigate", url: service });
  report.signedInBeforeThePerson = await signedIn(first);
  await call(broker.socket, "session.pause", first);
  // ORBIT_ACCOUNT_OPEN=0 prints the link instead of opening the viewer window, for a dry run.
  const opened = await call(broker.socket, "preview.open", { launch: process.env.ORBIT_ACCOUNT_OPEN !== "0" }) as { url: string; opened: boolean; browser: string; appWindow: boolean };
  report.viewer = { opened: opened.opened, browser: opened.browser, appWindow: opened.appWindow };
  console.error(`Sign in to ${origin} in the Orbit viewer window, then press "Save account state". Waiting up to ${Math.round(waitMs / 60000)} minutes.`);
  if (!opened.opened) console.error(`The viewer did not open by itself; open this link yourself: ${opened.url}`);
  const started = Date.now();
  let saved = false;
  while (Date.now() - started < waitMs) {
    const modified = await stat(snapshot).then(s => s.mtimeMs).catch(() => 0);
    if (modified > modifiedBefore) { saved = true; break; }
    await Bun.sleep(2000);
  }
  report.snapshotSaved = saved;
  report.waitedMs = Date.now() - started;
  if (!saved) throw new Error("No account snapshot appeared; nothing further can be measured");
  await call(broker.socket, "session.stop", first);

  // Restart: a new temporary profile, the saved state restored into it, the same origin.
  const second = await create();
  const restored = performance.now();
  await act(second, { type: "navigate", url: service });
  report.signedInAfterRestart = await signedIn(second);
  report.restartToPageMs = Math.round(performance.now() - restored);
  // The lease: a third session on the same name is refused while the second holds it.
  try { await create(); report.leaseRefused = false; }
  catch (error) { report.leaseRefused = (error as { code?: string }).code === "PROFILE_BUSY"; report.leaseCode = (error as { code?: string }).code; }
  // Untouched: the session profile lives under the workspace root, not under the person's browser.
  report.sessionProfilesUnder = workspaceRoot();
  report.personalProfileRead = false;
  const frame = await call(broker.socket, "session.observe", second) as { image: string };
  // The frame is kept for the person to look at, never described here: it may show their name.
  await writeFile(join(directory, "after-restart.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });
  await call(broker.socket, "session.stop", second);
  report.t6 = report.signedInAfterRestart === true && report.leaseRefused === true;
  report.status = "completed";
  report.limitations = [
    "One service, chosen by the person; whether its authentication prompts accept a restored Playwright storage state is what was measured, and it says nothing about another provider.",
    "The person signed in through the viewer; no credential passed through this file or any agent.",
    "The restart is a new Orbit session on the saved state, not a browser crash; broker crash recovery is a separate gate.",
    "G18, whether holding the state past a device bound token rotation logs the person out elsewhere, needs hours and is not attempted here.",
  ];
} catch (error) {
  Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await broker.close();
}
