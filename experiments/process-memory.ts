import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Diagnostic sample of this scope only. Never export full process arguments. */
export async function sampleProcessMemory(group: string) {
  const pids = (await readFile(join(group, "cgroup.procs"), "utf8")).trim().split(/\s+/).filter(Boolean);
  const processes = [];
  for (const pid of pids) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      const kb = (key: string) => Number(status.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
      processes.push({ pid: Number(pid), parentPid: kb("PPid"),
        name: status.match(/^Name:\s+(.+)$/m)?.[1],
        role: args.join(" ").match(/(?:^|\s)--type=([^\s]+)/)?.[1] ?? "main",
        rssKiB: kb("VmRSS"), anonymousKiB: kb("RssAnon"), fileKiB: kb("RssFile"), sharedKiB: kb("RssShmem") });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return { memoryBytes: Number(await readFile(join(group, "memory.current"), "utf8")), processes };
}
