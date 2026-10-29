/**
 * Which callers are still there.
 *
 * Requests arrive as one-shot HTTP over the Unix socket, so there is no connection whose closing could
 * announce that an adapter died. What the broker can watch is the adapter process each caller has
 * shown it: when every process registered under a caller id is gone, the caller has disconnected.
 * Only adapters are watched. A command line process lives for one call, so its exit says nothing
 * about the agent that ran it; sessions created through the CLI stay until stopped.
 */
import { processAlive, type Caller } from "./caller";

interface Entry { id: string; label: string; procs: Map<string, { pid: number; start?: string }>; gone: boolean; lastSeen: number }

export class CallerRegistry {
  private entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private options: {
    pollMs?: number; alive?: (pid: number, start?: string) => boolean;
    onGone?: (id: string, label: string) => void; onBack?: (id: string, label: string) => void;
  } = {}) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.options.pollMs ?? 500);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** Record a request. Adapter processes are remembered; a returning caller is announced. */
  touch(caller: Caller) {
    if (caller.kind !== "adapter" || caller.pid === undefined) return;
    let entry = this.entries.get(caller.id);
    if (!entry) { entry = { id: caller.id, label: caller.label, procs: new Map(), gone: false, lastSeen: Date.now() }; this.entries.set(caller.id, entry); }
    entry.procs.set(`${caller.pid}:${caller.start ?? ""}`, { pid: caller.pid, start: caller.start });
    entry.lastSeen = Date.now(); entry.label = caller.label;
    if (entry.gone) { entry.gone = false; this.options.onBack?.(entry.id, entry.label); }
  }
  /** An adapter that says goodbye on its way out is gone at once rather than at the next poll. */
  detach(caller: Caller) {
    const entry = this.entries.get(caller.id);
    if (!entry || caller.pid === undefined) return;
    entry.procs.delete(`${caller.pid}:${caller.start ?? ""}`);
    this.settle(entry);
  }
  /** true or false for a watched caller, undefined for one the registry does not track. */
  isAlive(id: string): boolean | undefined {
    const entry = this.entries.get(id);
    return entry ? !entry.gone : undefined;
  }
  sweep() {
    const alive = this.options.alive ?? processAlive;
    for (const entry of this.entries.values()) {
      for (const [key, proc] of entry.procs) if (!alive(proc.pid, proc.start)) entry.procs.delete(key);
      this.settle(entry);
    }
    // A caller gone for a day is forgotten; an id that returns is simply new.
    for (const [id, entry] of this.entries) if (entry.gone && Date.now() - entry.lastSeen > 86_400_000) this.entries.delete(id);
  }
  private settle(entry: Entry) {
    if (!entry.procs.size && !entry.gone) { entry.gone = true; this.options.onGone?.(entry.id, entry.label); }
  }
}
