import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDisposablePaginatedReader } from "./codex-paginated-bwrap-bridge";
import type { PaginatedPageRequest } from "../src/codex-authority-gate";

const root = await mkdtemp("/tmp/orbit-paginated-bridge-failures-");
const fixture = join(root, "fixture");
const request: PaginatedPageRequest = { method: "thread/turns/list", params: {
  threadId: "00000000-0000-4000-8000-000000000001", readOnly: true,
  limit: 1, sortDirection: "asc", itemsView: "full",
} };

async function fakeReader(name: string, script: string) {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/sh\n${script}\n`);
  await chmod(path, 0o700);
  return await createDisposablePaginatedReader(path, fixture);
}

async function expectsFailure(reader: (request: PaginatedPageRequest) => Promise<unknown>, phrase: string) {
  try { await reader(request); }
  catch (error) {
    if (error instanceof Error && error.message.includes(phrase)) return;
    throw error;
  }
  throw new Error(`Expected page reader failure: ${phrase}`);
}

try {
  await mkdir(join(fixture, "sessions"), { recursive: true });
  await writeFile(join(fixture, "state_5.sqlite"), "disposable");
  await writeFile(join(fixture, "thread_history_1.sqlite"), "disposable");

  const isolation = await fakeReader("isolation-helper", [
    "if [ -e /fixture/auth.json ] || [ -e /run/user ] || [ -S /fixture/owner.sock ]; then",
    "  echo 'ORBIT_PAGE_RESPONSE:16:{\"isolated\":false}'",
    "else",
    "  echo 'ORBIT_PAGE_RESPONSE:17:{\"isolated\":true}'",
    "fi",
  ].join("\n"));
  const isolated = await isolation(request) as { isolated?: boolean };
  if (isolated.isolated !== true) throw new Error("Disposable mount exposed a forbidden path");

  const malformed = await fakeReader("malformed-helper", "echo 'ORBIT_PAGE_RESPONSE:5:abc'");
  await expectsFailure(malformed, "invalid frame");

  const oversized = await fakeReader("oversized-helper", [
    "head -c 4194305 /dev/zero | tr '\\000' x",
    "echo",
  ].join("\n"));
  await expectsFailure(oversized, "output is too large");

  const delayed = await fakeReader("delayed-helper", "sleep 20");
  const started = Date.now();
  await expectsFailure(delayed, "process deadline");
  const elapsedMs = Date.now() - started;
  if (elapsedMs < 3300 || elapsedMs > 5000)
    throw new Error(`Process deadline elapsed in unexpected time: ${elapsedMs}`);
  let running: string[] = [];
  try {
    running = execFileSync("/usr/bin/pgrep", ["-af", join(root, "delayed-helper")],
      { encoding: "utf8" }).split("\n").filter(line => line.includes("/reader"));
  } catch { /* pgrep exits 1 when the helper is gone. */ }
  if (running.length > 0) throw new Error("Timed-out page helper process remained alive");

  console.log(JSON.stringify({ isolated: true, malformedRejected: true,
    oversizedRejected: true, timeoutKilledAndWaited: true, elapsedMs }));
} finally {
  await rm(root, { recursive: true, force: true });
}
