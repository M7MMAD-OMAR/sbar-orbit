import { createConnection } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const address = (value: unknown) => typeof value === "string" && /^(?:0x)?[a-f0-9]+$/i.test(value) ? value.replace(/^0x/i, "").toLowerCase() : null;
const pid = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;

/**
 * The process ids in a `cgroup.procs` file. An empty file has no processes in it, and that is not the
 * same as having one process whose id is nothing: `"".split(/\s+/)` is `[""]` and `Number("")` is 0,
 * so the obvious parse produced a set containing **pid 0**. Since `sanitizeFocus` also reports pid 0
 * for "no active window", the two zeros matched each other and a run with nothing to report printed
 * `activeOwned: true`. Measured on 20 September 2026: four samples in a ten minute run, on a desktop
 * where no Orbit window existed at all. A pid is a positive integer or it is not a process.
 */
export function parseProcessIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const token of text.split(/\s+/)) {
    const value = Number(token);
    if (Number.isInteger(value) && value > 0) ids.add(value);
  }
  return ids;
}

/** Pid 0 is "no window", so it can never be an owned one, whatever the caller's set happens to hold. */
export function ownsFocus(activePid: number, owned: Set<number>) {
  return activePid > 0 && owned.has(activePid);
}

/**
 * Every process under a cgroup root, its descendants included.
 *
 * `cgroup.procs` lists the processes in ONE cgroup and never in its children, so reading only the
 * slice would have missed the managed broker entirely: measured on this workstation, `sbarorbit.slice`
 * itself holds 0 processes while `sbarorbit.slice/sbar-orbit.service` holds 69. An owned set that is
 * empty makes every observation read as "nothing was owned", which is not evidence of anything.
 */
export async function readProcessSet(root: string): Promise<Set<number>> {
  const pids = new Set<number>();
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isDirectory()) await visit(join(directory, entry.name));
    for (const id of parseProcessIds(await readFile(join(directory, "cgroup.procs"), "utf8").catch(() => ""))) pids.add(id);
  };
  await visit(root);
  return pids;
}

/** Drop titles and all other metadata before retaining a snapshot. */
export function sanitizeFocus(active: unknown, clients: unknown) {
  if (!active || typeof active !== "object" || !Array.isArray(clients)) throw new Error("Invalid focus telemetry");
  const activeValue = active as Record<string, unknown>;
  const activePid = activeValue.pid === undefined && Object.keys(activeValue).length === 0 ? 0 : pid(activeValue.pid);
  if (activePid === null) throw new Error("Invalid active PID");
  return { activePid, clients: clients.map(value => {
    if (!value || typeof value !== "object") throw new Error("Invalid client telemetry");
    const item = value as Record<string, unknown>;
    const clientPid = pid(item.pid), clientAddress = address(item.address);
    if (clientPid === null || clientAddress === null) throw new Error("Invalid client identity");
    return { pid: clientPid, address: clientAddress };
  }) };
}

/** Read only activewindowv2. Never retain raw lines, window titles or other events. */
export function focusEvent(line: string): string | null | undefined {
  if (!line.startsWith("activewindowv2>>")) return undefined;
  const value = line.slice("activewindowv2>>".length);
  if (!value) return null;
  const parsed = address(value);
  if (!parsed) throw new Error("Malformed focus event");
  return parsed;
}

async function query(command: "activewindow" | "clients") {
  const child = Bun.spawn(["/usr/bin/hyprctl", "-j", command], { stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1500);
  try {
    const text = await new Response(child.stdout).text();
    if (await child.exited || timedOut || text.length > 2_000_000) throw new Error("Focus query failed");
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("Invalid focus query response"); }
  } finally { clearTimeout(timer); }
}

export async function startFocusMonitor(ownedPids: () => Promise<Set<number>>, intervalMs = 500) {
  const runtime = process.env.XDG_RUNTIME_DIR, signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!runtime || !signature || signature.includes("/")) throw new Error("Hyprland telemetry unavailable");
  if (!Number.isInteger(intervalMs) || intervalMs < 100) throw new Error("Invalid focus sample interval");
  const started = performance.now();
  const samples: { atMs: number; activeOwned: boolean; visibleOwnedCount: number }[] = [];
  const events: { atMs: number; owned: boolean | null }[] = [];
  let clients = new Map<string, number>(), owned = new Set<number>(), stopping = false, errors = 0, pending = "";
  const socket = createConnection(join(runtime, "hypr", signature, ".socket2.sock"));
  socket.on("error", () => { if (!stopping) errors++; });
  socket.on("close", () => { if (!stopping) errors++; });
  socket.on("data", chunk => {
    pending += chunk.toString("utf8");
    if (pending.length > 65536) { errors++; pending = ""; socket.destroy(); return; }
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const value = focusEvent(line);
        if (value === undefined) continue;
        const eventPid = value === null ? 0 : clients.get(value);
        events.push({ atMs: Math.round(performance.now() - started), owned: eventPid === undefined ? null : owned.has(eventPid) });
      } catch { errors++; }
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Focus event connection timed out")), 1500);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new Error("Focus event connection failed")); });
    });
  } catch (error) { stopping = true; socket.destroy(); throw error; }
  const sample = async () => {
    const [active, allClients, currentOwned] = await Promise.all([query("activewindow"), query("clients"), ownedPids()]);
    const snapshot = sanitizeFocus(active, allClients);
    owned = currentOwned; clients = new Map(snapshot.clients.map(item => [item.address, item.pid]));
    samples.push({ atMs: Math.round(performance.now() - started), activeOwned: ownsFocus(snapshot.activePid, owned),
      // A client with pid 0 is not a process either, for the same reason an empty procs file is not.
      visibleOwnedCount: snapshot.clients.filter(item => item.pid > 0 && owned.has(item.pid)).length });
  };
  try { await sample(); } catch (error) { stopping = true; socket.destroy(); throw error; }
  const loop = (async () => {
    while (!stopping) {
      await Bun.sleep(intervalMs);
      if (stopping) break;
      try { await sample(); } catch { errors++; }
    }
  })();
  return { async stop() {
    stopping = true; socket.destroy(); pending = ""; await loop;
    return { samples, events, errors, unresolvedFocusEvents: events.filter(event => event.owned === null).length,
      maximumSampleGapMs: Math.max(0, ...samples.slice(1).map((item, i) => item.atMs - samples[i]!.atMs)),
      limitations: ["Event ownership uses the last sampled client/PID map; short-lived or newly created windows can be unresolved.",
        "Polling and event delivery do not prove human participation or exclude every transient focus change.",
        "Raw IPC data is parsed in memory; persisted results omit titles, classes, addresses, PIDs and keystrokes."] };
  } };
}
