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
  const parts = group?.split("/");
  const at = parts?.indexOf("sbarorbit.slice");
  return parts && at !== undefined && at >= 0
    ? posix.join("/sys/fs/cgroup", ...parts.slice(0, at + 1)) : undefined;
}

/** No timer, sampling or output without an explicit selected owned fixture root. */
export function createBrowserStartupDiagnostic(profile: string,
  owner: () => { exitCode?: number | null; stderr?: string }) {
  const root = process.env.ORBIT_BROWSER_STARTUP_TRACE_ROOT;
  if (process.platform !== "linux" || process.env.ORBIT_BROWSER_STARTUP_TRACE !== "1" ||
    !root?.startsWith("/") || !profile.startsWith(root + "/")) return undefined;
  const launch = crypto.randomUUID();
  const started = performance.now();
  let sequence = 0;
  return { record(phase: string) {
    const event = { browserStartup: phase, launch, sequence: ++sequence,
      elapsedMs: Math.round(performance.now() - started), ...owner() };
    const stderr = startupDiagnosticStderr(event.stderr ?? "");
    void (async () => {
      const sampleStartedMs = Math.round(performance.now() - started);
      const counters: Record<string, string> = {};
      const unavailable: string[] = [];
      const read = async (key: string, path: string, firstLine = false) => {
        try {
          const value = (await readFile(path, "utf8")).trim();
          counters[key] = firstLine ? value.split("\n")[0] ?? "" : value;
        } catch { unavailable.push(key); }
      };
      let budgetRoot: string | undefined;
      try { budgetRoot = startupDiagnosticBudgetRoot(await readFile("/proc/self/cgroup", "utf8")); }
      catch { unavailable.push("budget-root"); }
      if (budgetRoot) await Promise.all(["cpu.stat", "cpu.pressure", "memory.pressure", "memory.current", "memory.events",
        "memory.max", "pids.current", "pids.max", "io.stat", "io.pressure"].map(file => read(file, join(budgetRoot, file))));
      else if (!unavailable.includes("budget-root")) unavailable.push("budget-root");
      await Promise.all([read("runner.cpu", "/proc/stat", true),
        ...["cpu", "io", "memory"].map(kind => read(`runner.${kind}.pressure`, `/proc/pressure/${kind}`))]);
      const sampleFinishedMs = Math.round(performance.now() - started);
      console.error(JSON.stringify({ ...event, stderr, sampleStartedMs, sampleFinishedMs, counters, unavailable }));
    })().catch(() => {});
  } };
}
