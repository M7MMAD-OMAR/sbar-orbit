import { spawn } from "node:child_process";
import { join } from "node:path";
import type { PaginatedPageRequest } from "../src/codex-authority-gate";

const DEADLINE_MS = 4500;

export function createLiveFixturePageReader(root: string, binary: string) {
  if (!root.startsWith("/tmp/orbit-paginated-live-") || !binary.includes("codex_thread_store-"))
    throw new Error("Live page reader accepts only the disposable owner fixture");
  return async (request: PaginatedPageRequest): Promise<unknown> => {
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.length > 4096) throw new Error("Private page request exceeds fixture limit");
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn("/usr/bin/python3", [join(import.meta.dir, "codex-paginated-live-page.py"),
        root, binary], { stdio: ["pipe", "pipe", "pipe"], detached: true });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let failure: Error | undefined;
      const fail = (error: Error) => {
        if (failure) return;
        failure = error;
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      };
      const deadline = setTimeout(() => fail(new Error("Private page process exceeded deadline")), DEADLINE_MS);
      child.stdout.on("data", chunk => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > 4 * 1024 * 1024) fail(new Error("Private page output exceeds fixture limit"));
      });
      child.stderr.on("data", chunk => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > 8192) stderr = stderr.subarray(0, 8192);
      });
      child.on("error", error => fail(error));
      child.on("close", code => {
        clearTimeout(deadline);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error(stderr.toString("utf8").slice(0, 256)));
        try { resolve(JSON.parse(stdout.toString("utf8")).page); }
        catch { reject(new Error("Private page returned invalid JSON")); }
      });
      child.stdin.on("error", fail);
      child.stdin.end(payload);
    });
  };
}
