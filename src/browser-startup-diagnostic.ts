import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/** Publish fixed stderr categories, never arbitrary browser or supervisor text. */
export function startupDiagnosticStderr(stderr: string) {
  const categories = new Set<string>();
  for (const line of stderr.split("\n")) {
    if (/^DevTools listening on wss?:/.test(line)) { categories.add("DevTools endpoint published"); continue; }
    const severity = /^\[[^\]]*:(ERROR|WARNING|FATAL):[^\]]*\]/.exec(line)?.[1];
    if (!severity) continue;
    const category = /Failed to connect to the bus/.test(line) ? "dbus connection failed"
      : /NameHasOwner|Properties.GetAll/.test(line) ? "dbus method failed"
      : /Read channel/.test(line) ? "browser channel discovered"
      : /fork|pthread_create|Resource temporarily unavailable/.test(line) ? "task creation failure message"
      : /Permission denied|EACCES/.test(line) ? "permission failure message"
      : /No space left|ENOSPC/.test(line) ? "storage failure message"
      : /out of memory|ENOMEM|OOM/.test(line) ? "memory failure message"
      : "other browser message";
    categories.add(`[${severity}] ${category}`);
  }
  return [...categories].join("\n").slice(-2048);
}

/** Use the same named ancestor as the resource-budget enforcement. */
export function startupDiagnosticBudgetRoot(cgroup: string) {
  const group = cgroup.split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!group?.startsWith("/") || posix.normalize(group) !== group || group.includes("\0") || Buffer.byteLength(cgroup, "utf8") > 4096) return undefined;
  const parts = group?.split("/");
  const at = parts?.indexOf("sbarorbit.slice");
  return parts && at !== undefined && at >= 0
    ? posix.join("/sys/fs/cgroup", ...parts.slice(0, at + 1)) : undefined;
}

/** Keep unavailable counters explicit when individual resource reads fail. */
export async function sampleBrowserStartupDiagnostic(readResource: (path: string) => Promise<string> = path => readFile(path, "utf8")) {
  const counters: Record<string, string> = {};
  const unavailable: string[] = [];
  const read = async (key: string, path: string, firstLine = false) => {
    try {
      const value = (await readResource(path)).trim();
      counters[key] = firstLine ? value.split("\n")[0] ?? "" : value;
    } catch { unavailable.push(key); }
  };
  let cgroupAncestry: string | null = null;
  let budgetRoot: string | null = null;
  try {
    const ancestry = await readResource("/proc/self/cgroup");
    if (Buffer.byteLength(ancestry, "utf8") > 4096) throw new Error("Cgroup ancestry exceeds diagnostic bound");
    cgroupAncestry = ancestry;
    budgetRoot = startupDiagnosticBudgetRoot(ancestry) ?? null;
  } catch { unavailable.push("cgroup-ancestry"); }
  if (budgetRoot) await Promise.all(["cpu.stat", "cpu.pressure", "memory.pressure", "memory.current", "memory.events",
    "memory.max", "pids.current", "pids.max", "io.stat", "io.pressure"].map(file => read(file, join(budgetRoot, file))));
  else if (!unavailable.includes("budget-root")) unavailable.push("budget-root");
  await Promise.all([read("runner.cpu", "/proc/stat", true),
    ...["cpu", "io", "memory"].map(kind => read(`runner.${kind}.pressure`, `/proc/pressure/${kind}`))]);
  return { counters, unavailable, cgroupAncestry, budgetRoot };
}

type FixtureIdentity = { device: number; inode: number; uid: number };
const selectedFixtures = new Map<string, FixtureIdentity>();

function privateDiagnosticDirectory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 || realpathSync(path) !== path) return;
  return { device: info.dev, inode: info.ino, uid: info.uid };
}

/** Bind the generated saved-account fixture to this process's actual private root identity. */
export function registerBrowserStartupFixture(root: string) {
  const noop = () => {};
  if (process.platform !== "linux" || process.env.ORBIT_BROWSER_STARTUP_TRACE !== "1" ||
      !root.startsWith("/") || posix.normalize(root) !== root || !/^account-test-[a-zA-Z0-9]{6}$/.test(posix.basename(root))) return noop;
  try {
    const identity = privateDiagnosticDirectory(root);
    if (!identity) return noop;
    selectedFixtures.set(root, identity);
    return () => { if (selectedFixtures.get(root) === identity) selectedFixtures.delete(root); };
  } catch { return noop; }
}

function admittedStartupFixture(root: string, profile: string) {
  const expected = selectedFixtures.get(root);
  if (!expected) return false;
  const actual = privateDiagnosticDirectory(root);
  if (!actual || actual.device !== expected.device || actual.inode !== expected.inode || actual.uid !== expected.uid) return false;
  let current = root;
  for (const part of posix.relative(root, profile).split("/")) {
    current = posix.join(current, part);
    if (!privateDiagnosticDirectory(current)) return false;
  }
  return true;
}

/** No timer, sampling or output without an explicit selected owned fixture root. */
export function createBrowserStartupDiagnostic(profile: string,
  owner: () => { exitCode?: number | null; stderr?: string }) {
  const root = process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT;
  if (process.platform !== "linux" || process.env.ORBIT_BROWSER_STARTUP_TRACE !== "1" ||
    !root?.startsWith("/") || root === "/" || posix.normalize(root) !== root ||
    posix.normalize(profile) !== profile || !profile.startsWith(root + "/")) return undefined;
  try { if (!admittedStartupFixture(root, profile)) return undefined; } catch { return undefined; }
  const launch = crypto.randomUUID();
  const started = performance.now();
  let sequence = 0;
  return { record(phase: string) {
    try {
      const event = { browserStartup: phase, launch, sequence: ++sequence,
        elapsedMs: Math.round(performance.now() - started), ...owner() };
      const stderr = startupDiagnosticStderr(event.stderr ?? "");
      void (async () => {
        const sampleStartedMs = Math.round(performance.now() - started);
        const { counters, unavailable, cgroupAncestry, budgetRoot } = await sampleBrowserStartupDiagnostic();
        const sampleFinishedMs = Math.round(performance.now() - started);
        console.error(JSON.stringify({ ...event, stderr, sampleStartedMs, sampleFinishedMs, counters, unavailable, cgroupAncestry, budgetRoot }));
      })().catch(() => {});
    } catch {}
  } };
}
