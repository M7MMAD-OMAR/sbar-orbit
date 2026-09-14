import { call } from "./ipc";
import { serviceSocketPath } from "./service";
import { OrbitError } from "./errors";

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

/** Read locally, never from the broker: a version waiting is a fact about the disk, not about a session. */
async function pendingVersion() {
  try {
    const { updateStatus } = await import("./update");
    const update = await updateStatus({ openSessions: async () => null });
    return update.pending.length ? { pendingVersion: update.pending.at(-1) } : {};
  } catch { return {}; }
}

export async function readStatus(socket: string): Promise<Status> {
  const list = await call(socket, "session.list") as SessionStatus[];
  const open = list.filter(session => !["closed", "closing"].includes(session.state));
  const sessions = await Promise.all(open.map(async session => {
    try {
      const presence = await call(socket, "session.presence", { sessionId: session.sessionId }) as Partial<SessionStatus>;
      return { ...session, title: presence.title, location: presence.location, tabs: presence.tabs, pointer: presence.pointer ?? null };
    } catch { return session; }
  }));
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
  let previous = "";
  const once = async () => {
    let socket = "";
    try {
      socket = socketFromEnvironment();
      const status = await readStatus(socket);
      delay = status.working ? 1000 : status.sessions.length ? 2000 : 3000;
      const line = JSON.stringify({ ...status, summary: summarize(status) });
      // Timestamps change every read; compare everything else so a quiet desktop prints nothing.
      const shape = JSON.stringify({ ...status, sampledAt: undefined, summary: summarize(status) });
      if (shape !== previous) { console.log(line); previous = shape; }
    } catch (error) {
      const line = JSON.stringify({ socket, reachable: false, summary: "Orbit not running",
        code: error instanceof OrbitError ? error.code : "BROKER_UNAVAILABLE" });
      if (line !== previous) { console.log(line); previous = line; }
      delay = 5000;
      if (!watch) process.exitCode = 1;
    }
  };
  // One read at a time: a slow broker must not accumulate overlapping reads. The cadence is the
  // panel's: a second while an agent is acting, slower as there is less to see, so an idle desktop
  // costs one list call every three seconds rather than one a second.
  let delay = 1000;
  const loop = async () => { await once(); if (watch) setTimeout(loop, delay); };
  await loop();
}
