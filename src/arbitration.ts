/**
 * When two agents want the same thing: who holds it, who is next, and where a new window may go.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrbitError } from "./errors";
import { connectorConfigDirectory } from "./service";

export interface Holder { label: string; task: string; idleSeconds: number; alive: boolean | undefined; state: string }

export function duration(seconds: number) {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/**
 * The busy answer. Same shape as the plugin's own "already leased by" message, with the Orbit session
 * that holds the lease named instead of a lease id and a pid.
 */
export function busyMessage(holder: Holder | undefined, queue: { position: number; waiting: number } | undefined, pluginDetail?: string) {
  let text: string;
  if (holder) {
    const aliveText = holder.alive === false ? "its adapter is gone, so it is an orphan and is stopped after its grace period"
      : holder.alive === true ? "its adapter is alive" : "its adapter is not tracked";
    text = `Application client is already leased by ${holder.label} (task "${holder.task}", ${holder.state}, idle ${duration(holder.idleSeconds)}); ${aliveText}`;
  } else text = pluginDetail ?? "Application client is already leased or native lease capacity is reached";
  if (queue) text += `. You are number ${queue.position} of ${queue.waiting} waiting for it`;
  return text + ". Ask the holder to stop its session, pick another application window, or retry with wait to queue for it.";
}

/** First come, first served per application client, with a waiter dropped once it stops asking. */
export class WaitQueue {
  private queues = new Map<string, { callerId: string; since: number; seen: number }[]>();
  constructor(private staleMs = 90_000, private now = () => Date.now()) {}
  private fresh(key: string) {
    const queue = (this.queues.get(key) ?? []).filter(entry => this.now() - entry.seen < this.staleMs);
    if (queue.length) this.queues.set(key, queue); else this.queues.delete(key);
    return queue;
  }
  /** Joins or refreshes this caller's place, and returns it (1 is the front). */
  enter(key: string, callerId: string) {
    const queue = this.fresh(key);
    const existing = queue.find(entry => entry.callerId === callerId);
    if (existing) existing.seen = this.now();
    else { queue.push({ callerId, since: this.now(), seen: this.now() }); this.queues.set(key, queue); }
    return { position: queue.findIndex(entry => entry.callerId === callerId) + 1, waiting: queue.length };
  }
  /** Where this caller stands without joining. */
  ahead(key: string, callerId: string) {
    const queue = this.fresh(key);
    const index = queue.findIndex(entry => entry.callerId === callerId);
    return index === -1 ? queue.length : index;
  }
  leave(key: string, callerId: string) {
    const queue = this.fresh(key).filter(entry => entry.callerId !== callerId);
    if (queue.length) this.queues.set(key, queue); else this.queues.delete(key);
  }
}

export function parseWait(value: unknown): number {
  if (value === undefined || value === false) return 0;
  if (value === true) return 30;
  // One call must finish inside the client's own 45 second bound.
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.min(40, Math.floor(value));
  throw new OrbitError("INVALID_REQUEST", "wait is true or a number of seconds from 1 to 40");
}

/** `20-99` by default. Workspaces below it stay the person's. */
export function workspacePool(env: Record<string, string | undefined> = process.env): [number, number] {
  const match = /^(\d{1,6})-(\d{1,6})$/.exec(env.ORBIT_WORKSPACE_POOL ?? "");
  if (match && Number(match[1]) >= 1 && Number(match[2]) >= Number(match[1])) return [Number(match[1]), Number(match[2])];
  return [20, 99];
}

/**
 * A free numbered workspace for one caller. A workspace this caller already holds wins, so its windows
 * stay together; otherwise the lowest one nobody uses and no monitor shows.
 */
export function allocateWorkspace(input: { pool: [number, number]; own: number[]; used: Set<number>; shown: Set<number> }): number {
  const free = (workspace: number) => !input.used.has(workspace) && !input.shown.has(workspace);
  const mine = input.own.find(workspace => input.pool[0] <= workspace && workspace <= input.pool[1] && !input.shown.has(workspace));
  if (mine !== undefined) return mine;
  for (let workspace = input.pool[0]; workspace <= input.pool[1]; workspace++) if (free(workspace)) return workspace;
  throw new OrbitError("LIMIT_REACHED", "Every workspace in the agent pool is in use by a session or shown on a monitor; stop a session or widen ORBIT_WORKSPACE_POOL");
}

/**
 * Seconds a disconnected adapter's sessions wait before they are stopped. The environment wins, then
 * the broker setting `orbit.session.graceSeconds`, then 60. Read at each disconnect, so changing it
 * needs no restart.
 */
export function graceSeconds(env: Record<string, string | undefined> = process.env, directory = connectorConfigDirectory(env)): number {
  const clamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(3600, Math.max(0, value)) : undefined;
  const fromEnv = env.ORBIT_SESSION_GRACE_SECONDS === undefined ? undefined : clamp(Number(env.ORBIT_SESSION_GRACE_SECONDS));
  if (fromEnv !== undefined) return fromEnv;
  try {
    const stored = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")) as Record<string, unknown>;
    return clamp(stored["orbit.session.graceSeconds"]) ?? 60;
  } catch { return 60; }
}
