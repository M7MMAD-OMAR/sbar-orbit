import { opendir } from "node:fs/promises";
import { join } from "node:path";

export const maxApplicationEntries = 4096;
export async function boundedApplicationEntries(root: string, limit = maxApplicationEntries, recursive = true, deadline = Infinity) {
  const entries: string[] = []; const pending = [""]; let scanned = 0;
  while (pending.length) {
    if (Date.now() >= deadline) return { entries, scanned, truncated: true };
    const directory = pending.pop(); if (directory === undefined) break;
    try {
      // Bun can defer directory errors until iteration, after opendir resolves.
      const handle = await opendir(join(root, directory));
      for await (const entry of handle) {
        if (scanned >= limit || Date.now() >= deadline) return { entries, scanned, truncated: true };
        scanned++;
        const path = join(directory, entry.name); entries.push(path);
        if (recursive && entry.isDirectory()) pending.push(path);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { entries, scanned, truncated: true };
    }
  }
  return { entries, scanned, truncated: false };
}
