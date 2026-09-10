import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { OrbitError } from "./errors";

/** The shared budget the broker must run inside, matching what scripts/limited.ts applies at runtime. */
export const budget = { CPUQuota: "100%", MemoryHigh: "1792M", MemoryMax: "2G", MemorySwapMax: "0", TasksMax: "512", CPUWeight: "10", IOWeight: "10" };

/**
 * A fixed socket path for a managed broker. Brokers started by tests and experiments keep their own
 * private directories, so only the managed one uses this path and they cannot collide.
 */
export function serviceSocketPath(runtimeDirectory = process.env.XDG_RUNTIME_DIR) {
  if (!runtimeDirectory) throw new OrbitError("CONFIG_REQUIRED", "XDG_RUNTIME_DIR is required for a managed broker socket");
  return join(runtimeDirectory, "sbar-orbit", "broker.sock");
}

/** Refuse to displace a broker that still answers; clear only a socket file nothing is serving. */
export async function claimSocket(socket: string, probe: (path: string) => Promise<boolean>) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  let existing;
  try { existing = await stat(socket); } catch { return { claimed: true, replacedStaleSocket: false }; }
  if (!existing.isSocket()) throw new OrbitError("CONFIG_REQUIRED", `${socket} exists and is not a socket; remove it deliberately`);
  if (await probe(socket)) throw new OrbitError("PROFILE_BUSY", `An Orbit broker is already serving ${socket}`);
  await unlink(socket);
  return { claimed: true, replacedStaleSocket: true };
}

/** The budget sits on the slice, because the broker looks for sbarorbit.slice in its own cgroup path. */
export function sliceUnit() {
  return ["[Unit]", "Description=Sbar Orbit shared resource budget", "", "[Slice]",
    ...Object.entries(budget).map(([key, value]) => `${key}=${value}`), ""].join("\n");
}

export function serviceUnit(launcher: string) {
  return ["[Unit]", "Description=Sbar Orbit local broker", "", "[Service]", "Type=simple",
    `ExecStart=${launcher} serve --managed-socket`, "Slice=sbarorbit.slice",
    "Restart=on-failure", "RestartSec=2", "Nice=10",
    // The broker owns browsers and private displays, so give it time to close them.
    "TimeoutStopSec=30", "KillMode=mixed", "", "[Install]", "WantedBy=default.target", ""].join("\n");
}

const units = { "sbarorbit.slice": sliceUnit, "sbar-orbit.service": serviceUnit } as const;

/** Write both units atomically. Enabling and starting stay separate, deliberate steps. */
export async function installService(launcher: string, unitDirectory: string) {
  const source = resolve(launcher);
  try { if (!(await stat(source)).isFile()) throw new Error("Launcher is not a regular file"); }
  catch { throw new OrbitError("CONFIG_REQUIRED", "Launcher path is not a regular file"); }
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const [name, build] of Object.entries(units)) {
    const target = join(unitDirectory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, build(source), { mode: 0o644 });
    await rename(temporary, target);
    written.push(target);
  }
  return { written, launcher: source, enabled: false, started: false };
}

/** Remove only units this project wrote, identified by their own description line. */
export async function uninstallService(unitDirectory: string) {
  const removed: string[] = [];
  for (const name of Object.keys(units)) {
    const target = join(unitDirectory, name);
    let contents;
    try { contents = await readFile(target, "utf8"); } catch { continue; }
    if (!contents.includes("Description=Sbar Orbit")) throw new OrbitError("CONFIG_REQUIRED", `${target} was not written by Orbit; remove it deliberately`);
    await rm(target);
    removed.push(target);
  }
  return { removed, sourceAndDataRetained: true };
}
