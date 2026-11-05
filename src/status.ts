import { call } from "./ipc";
import { serviceSocketPath } from "./service";
import { OrbitError } from "./errors";
import { ConversationUsage } from "./conversation-usage";

/**
 * One read-only view of everything the broker owns, for a desktop indicator, a bar module or a
 * person at a terminal. It is what `session.list` and `session.presence` already return, joined,
 * with the counts a glance needs on top. It never captures a frame and never opens a viewer.
 *
 * `--watch` prints a line whenever the view changes. Polling at one second costs one list call and
 * one presence call per open session; a session's presence is a compositor tree query or a page
 * title read, both measured well under a millisecond of broker time.
 */
export interface SessionStatus {
  sessionId: string; state: string; backend: string; agentName: string; taskName: string;
  activity?: { type: string; actor: string; state: string; sequence: number };
  surface?: { width: number; height: number };
  title?: string; location?: string; tabs?: { tab: number; label: string; active: boolean }[];
  pointer?: { x: number; y: number } | null;
}
export interface Status {
  socket: string; sampledAt: string; running: number; paused: number; working: number;
  tabs: number; windows: number; sessions: SessionStatus[];
  /** A version prepared and waiting for a boundary, so a person can see one is waiting rather than wonder. */
  pendingVersion?: string;
}

export function socketFromEnvironment(env = process.env): string {
  return env.ORBIT_SOCKET || serviceSocketPath(env.XDG_RUNTIME_DIR);
}

/**
 * Read locally, never from the broker: a version waiting is a fact about the disk, not about a session.
 * `--watch` calls this every second while a session is working, so it was measured before it was kept:
 * 0.13 ms per call against a 1.18 ms tick on this host, 500 calls, which is 0.01% of a core at that
 * cadence and nothing the CPU sampler can see. The broker is not asked, which is the half that would
 * have cost something.
 */
async function pendingVersion() {
  try {
    const { updateStatus } = await import("./update");
    const update = await updateStatus({ openSessions: async () => null });
    return update.pending.length ? { pendingVersion: update.pending.at(-1) } : {};
  } catch { return {}; }
}

/** Optional trusted direct-entry guard; imported CLI/panel callers retain their existing behavior. */
export async function readStatus(socket: string, check?: () => Promise<void>): Promise<Status> {
  if (check) await check();
  const list = await call(socket, "session.list") as SessionStatus[];
  if (check) await check(); // A completed list does not authorize later presence calls.
  const open = list.filter(session => !["closed", "closing"].includes(session.state));
  const sessions = await Promise.all(open.map(async session => {
    // Another agent's session arrives as a summary with no id, so there is no presence to read.
    if (!session.sessionId) return session;
    if (check) await check(); // Outside the catch: usage refusal must propagate.
    try {
      const presence = await call(socket, "session.presence", { sessionId: session.sessionId }) as Partial<SessionStatus>;
      return { ...session, title: presence.title, location: presence.location, tabs: presence.tabs, pointer: presence.pointer ?? null };
    } catch { return session; }
  }));
  if (check) await check(); // Before starting the pending-version disk reads below.
  const count = (backend: string) => sessions.filter(s => s.backend === backend).reduce((sum, s) => sum + (s.tabs?.length ?? 0), 0);
  return {
    socket, sampledAt: new Date().toISOString(),
    running: sessions.filter(s => s.state === "running").length,
    paused: sessions.filter(s => s.state === "paused").length,
    working: sessions.filter(s => s.activity?.state === "working").length,
    tabs: count("browser"), windows: count("fedora"), sessions,
    ...(await pendingVersion()),
  };
}

/** A short line for a bar: nothing, or counts. */
export function summarize(status: Status): string {
  const total = status.sessions.length;
  if (!total) return status.pendingVersion ? `Orbit idle, ${status.pendingVersion} waiting` : "Orbit idle";
  const parts = [`${total} session${total === 1 ? "" : "s"}`];
  if (status.working) parts.push(`${status.working} working`);
  if (status.paused) parts.push(`${status.paused} paused`);
  if (status.tabs) parts.push(`${status.tabs} tab${status.tabs === 1 ? "" : "s"}`);
  if (status.windows) parts.push(`${status.windows} window${status.windows === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

if (import.meta.main) {
  const watch = process.argv.includes("--watch");
  let previous = "", delay = 1000, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let usage: ConversationUsage | undefined;
  const stopUsage = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const code = error instanceof OrbitError && ["ORBIT_DISABLED", "INVALID_REQUEST", "USAGE_STATE_INVALID"].includes(error.code)
      ? error.code : "USAGE_STATE_INVALID";
    // Usage refusal is terminal, not a broker reachability failure. Never echo
    // the conversation ID, state path, socket or an arbitrary exception string.
    console.error(JSON.stringify({ ok: false, error: { code, message: "Status unavailable under conversation usage settings" } }));
    process.exitCode = 1;
  };
  try { usage = new ConversationUsage(); } catch (error) { stopUsage(error); }
  const enabled = async () => {
    if (stopped) return false;
    if (!usage) { stopUsage(undefined); return false; }
    try { await usage.assertEnabled(); return !stopped; }
    catch (error) { stopUsage(error); return false; }
  };
  const once = async () => {
    let socket = "";
    if (!await enabled()) return; // Before broker calls or pending-version reads.
    try {
      socket = socketFromEnvironment();
      const status = await readStatus(socket, async () => {
        if (!await enabled()) throw new OrbitError("ORBIT_DISABLED", "Status unavailable");
      });
      // This suppresses delivery after off is observed, but cannot cancel list,
      // concurrent presence calls or disk reads already admitted by readStatus.
      // This is a point-in-time preference check, not an atomic off/on fence
      // spanning the filesystem read and console output.
      if (!await enabled()) return;
      delay = status.working ? 1000 : status.sessions.length ? 2000 : 3000;
      const line = JSON.stringify({ ...status, summary: summarize(status) });
      // Timestamps change every read; compare everything else so a quiet desktop prints nothing.
      const shape = JSON.stringify({ ...status, sampledAt: undefined, summary: summarize(status) });
      if (shape !== previous) { console.log(line); previous = shape; }
    } catch (error) {
      // Off during a failing broker read must not become "Orbit not running".
      if (!await enabled()) return;
      const line = JSON.stringify({ socket, reachable: false, summary: "Orbit not running",
        code: error instanceof OrbitError ? error.code : "BROKER_UNAVAILABLE" });
      if (line !== previous) { console.log(line); previous = line; }
      delay = 5000;
      if (!watch) process.exitCode = 1;
    }
  };
  // One admitted poll at a time. A terminal usage refusal never schedules another.
  const loop = async () => {
    timer = undefined;
    await once();
    if (watch && !stopped) timer = setTimeout(() => { void loop(); }, delay);
  };
  await loop();
}
