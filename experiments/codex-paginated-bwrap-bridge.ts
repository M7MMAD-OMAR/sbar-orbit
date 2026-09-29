import { spawn } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PaginatedPageRequest } from "../src/codex-authority-gate";

const MAX_INPUT = 4096;
const MAX_OUTPUT = 4 * 1024 * 1024;
const CHILD_DEADLINE_MS = 3500;
const TOP_LEVEL = new Set(["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm",
  "thread_history_1.sqlite", "thread_history_1.sqlite-wal", "thread_history_1.sqlite-shm", "sessions"]);

export async function createDisposablePaginatedReader(binary: string, fixture: string) {
  const helperBinary = await realpath(binary);
  const fixtureRoot = await realpath(fixture);
  if (!(await lstat(helperBinary)).isFile() || !(await lstat(fixtureRoot)).isDirectory())
    throw new Error("Disposable page helper inputs are unavailable");
  const entries = await readdir(fixtureRoot);
  if (entries.length === 0 || entries.some(entry => !TOP_LEVEL.has(entry)) ||
      !entries.includes("state_5.sqlite") || !entries.includes("thread_history_1.sqlite") ||
      !entries.includes("sessions"))
    throw new Error("Disposable fixture contains unexpected files");
  for (const entry of entries) {
    const path = join(fixtureRoot, entry);
    const info = await lstat(path);
    if (!(entry === "sessions" ? info.isDirectory() : info.isFile()))
      throw new Error("Disposable fixture contains an invalid entry");
  }
  const walkSessions = async (path: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("Disposable fixture sessions are too deep");
    const children = await readdir(path);
    if (children.length > 100) throw new Error("Disposable fixture directory is too large");
    for (const child of children) {
      const file = join(path, child);
      const info = await lstat(file);
      if (info.isDirectory()) await walkSessions(file, depth + 1);
      else if (!info.isFile() || !child.endsWith(".jsonl") || info.size > 64 * 1024 * 1024)
        throw new Error("Disposable fixture contains an unexpected session entry");
    }
  };
  await walkSessions(join(fixtureRoot, "sessions"), 0);

  return async (request: PaginatedPageRequest): Promise<unknown> => {
    if (request.params.sortDirection !== "asc" ||
        (request.method === "thread/turns/list" && request.params.itemsView !== "full"))
      throw new Error("Disposable helper only supports ascending full pages");
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.length < 1 || payload.length > MAX_INPUT)
      throw new Error("Disposable page request is too large");
    const args = ["--die-with-parent", "--unshare-all", "--new-session", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      "--ro-bind", fixtureRoot, "/fixture", "--ro-bind", helperBinary, "/reader",
      "--setenv", "HOME", "/tmp", "--setenv", "ORBIT_BWRAP_PAGE_HELPER", "1",
      "--", "/reader", "bwrap_paginated_page_helper_child", "--nocapture"];
    return await new Promise<unknown>((resolvePage, rejectPage) => {
      const child = spawn("/usr/bin/bwrap", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let failure: Error | undefined;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) rejectPage(error);
        else resolvePage(result);
      };
      const killGroup = (error: Error) => {
        if (failure) return;
        failure = error;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { child.kill("SIGKILL"); }
      };
      const deadline = setTimeout(() => killGroup(
        new Error("Disposable page helper exceeded its process deadline")), CHILD_DEADLINE_MS);
      child.stdout.on("data", chunk => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_OUTPUT) killGroup(new Error("Disposable page helper output is too large"));
      });
      child.stderr.on("data", chunk => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > 8192) stderr = stderr.subarray(0, 8192);
      });
      child.once("error", error => finish(error));
      child.once("close", code => {
        if (settled) return;
        if (failure) return finish(failure);
        if (code !== 0) return finish(new Error(`Disposable page helper exited ${code}: ${stderr.toString("utf8").slice(0, 256)}`));
        const frame = stdout.toString("utf8").split("\n").find(line => line.startsWith("ORBIT_PAGE_RESPONSE:"));
        if (!frame) return finish(new Error("Disposable page helper returned no response frame"));
        const match = /^ORBIT_PAGE_RESPONSE:(\d+):(.*)$/u.exec(frame);
        if (!match || !match[1] || match[2] === undefined || Number(match[1]) !== Buffer.byteLength(match[2]))
          return finish(new Error("Disposable page helper returned an invalid frame"));
        try { finish(undefined, JSON.parse(match[2])); }
        catch { finish(new Error("Disposable page helper returned invalid JSON")); }
      });
      child.stdin.on("error", error => killGroup(error));
      child.stdin.end(Buffer.concat([Buffer.from(`${payload.length}\n`), payload]));
    });
  };
}
