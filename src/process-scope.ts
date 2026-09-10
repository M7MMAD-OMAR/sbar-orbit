import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const disappeared = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Snapshot all task-thread child lists. This is sampling, not a security boundary. */
export async function auditProcessScope(rootPid = process.pid, procRoot = "/proc") {
  const expected = await readFile(join(procRoot, "self/cgroup"), "utf8");
  const pending = [rootPid], visited = new Set<number>();
  const escaped: { pid: number; cgroup: string }[] = [];
  let checked = 0, disappearedProcesses = 0;
  while (pending.length) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    try {
      const directory = join(procRoot, String(pid));
      const actual = await readFile(join(directory, "cgroup"), "utf8");
      checked++;
      if (actual !== expected) escaped.push({ pid, cgroup: actual.trim() });
      for (const tid of await readdir(join(directory, "task"))) {
        try {
          const text = await readFile(join(directory, "task", tid, "children"), "utf8");
          for (const token of text.trim().split(/\s+/).filter(Boolean)) {
            if (!/^\d+$/.test(token)) throw new Error("Invalid process child list");
            pending.push(Number(token));
          }
        } catch (error) { if (!disappeared(error)) throw error; }
      }
    } catch (error) { if (!disappeared(error)) throw error; disappearedProcesses++; }
  }
  return { checked, disappearedProcesses, escaped };
}
