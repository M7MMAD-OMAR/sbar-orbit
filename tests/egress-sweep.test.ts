/**
 * The egress socket directories a killed broker leaves behind.
 *
 * `tests/browser-crash.test.ts` SIGKILLs a broker and proves no descendant survives. It never looks
 * at the filesystem, so it could not see this: a bounded-origin session opens
 * `$XDG_RUNTIME_DIR/sbar-orbit/egress/<8 hex>` holding `lease.sock` and `cdp.sock`, and
 * `EgressLease.close()` removes it, which is exactly what SIGKILL does not run. `cleanWorkspaces`
 * walks the WORKSPACE root and knows nothing about the runtime one, so no `clean` path removed them
 * either. Measured on the developer's workstation after a day of runs: 33 abandoned directories.
 *
 * Not merely untidy. `src/fedora.ts` carries the reasoning already: tmpfs pages are charged to the
 * cgroup that wrote them, and left behind, closed sessions kept filling the shared memory budget
 * until the kernel throttled everything still running.
 *
 * These drive `cleanEgress` against REAL directories with REAL unix sockets rather than a mocked
 * filesystem, because the whole defect lives in the difference between a socket that is a live
 * listener and a socket that is a leftover inode, and a mock is free to get that wrong.
 */
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanEgress, egressRoot } from "../src/workspace-storage";

const old = async (path: string) => {
  // Older than the grace period, so the sweep is allowed to consider it. Without this every test
  // directory is seconds old and is kept, and the assertions would all be about the grace instead.
  const when = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(path, when, when);
};

test("a directory whose lease socket has no listener is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-egress-"));
  try {
    const dead = join(root, "deadbeef");
    await mkdir(dead, { recursive: true });
    // A real unix socket file with nothing listening: bind a server, then stop it, which is exactly
    // the inode a SIGKILLed broker leaves. Writing a plain file instead would test a different thing.
    const socket = join(dead, "lease.sock");
    const server = Bun.listen({ unix: socket, socket: { data() {} } });
    server.stop(true);
    await old(dead);

    const result = await cleanEgress(root);
    expect(result.removed).toEqual(["deadbeef"]);
    expect(result.kept).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("a directory with a LIVE listener is kept, which is the control that stops this from deleting working sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-egress-live-"));
  const alive = join(root, "aliveaaa");
  let server: ReturnType<typeof Bun.listen> | undefined;
  try {
    await mkdir(alive, { recursive: true });
    server = Bun.listen({ unix: join(alive, "lease.sock"), socket: { data() {} } });
    await old(alive);

    const result = await cleanEgress(root);
    // The important half. A sweep that removes everything would satisfy the test above and destroy
    // the egress socket of a session in use.
    expect(result.kept).toEqual(["aliveaaa"]);
    expect(result.removed).toEqual([]);
    expect(await readdir(root)).toEqual(["aliveaaa"]);
  } finally {
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("live and dead directories in one sweep are told apart", async () => {
  // Together, because the two tests above each pass against a sweep with a hardcoded answer.
  const root = await mkdtemp(join(tmpdir(), "orbit-egress-mixed-"));
  let server: ReturnType<typeof Bun.listen> | undefined;
  try {
    const alive = join(root, "aaaalive"), dead = join(root, "bbbbdead");
    await mkdir(alive, { recursive: true });
    await mkdir(dead, { recursive: true });
    server = Bun.listen({ unix: join(alive, "lease.sock"), socket: { data() {} } });
    const doomed = Bun.listen({ unix: join(dead, "lease.sock"), socket: { data() {} } });
    doomed.stop(true);
    await old(alive); await old(dead);

    const result = await cleanEgress(root);
    expect(result.removed).toEqual(["bbbbdead"]);
    expect(result.kept).toEqual(["aaaalive"]);
  } finally {
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("a directory with no lease socket at all is removed", async () => {
  // The shape left by a broker killed between mkdir and listen.
  const root = await mkdtemp(join(tmpdir(), "orbit-egress-empty-"));
  try {
    const empty = join(root, "cccccccc");
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, "confined-browser.sh"), "#!/bin/sh\n");
    await old(empty);
    expect((await cleanEgress(root)).removed).toEqual(["cccccccc"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("a directory younger than the grace is kept even with no listener", async () => {
  // A session being set up right now has its directory and may not have bound yet. A sweep that
  // deletes it takes the socket out from under a session about to use it, which is worse than
  // leaving one directory for one more sweep.
  const root = await mkdtemp(join(tmpdir(), "orbit-egress-young-"));
  try {
    const young = join(root, "dddddddd");
    await mkdir(young, { recursive: true });
    // Deliberately NOT aged.
    const result = await cleanEgress(root);
    expect(result.kept).toEqual(["dddddddd"]);
    expect(result.removed).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("a missing root is not an error", async () => {
  // A machine that has never opened a bounded-origin session has no such directory, and `clean`
  // must not fail on it.
  const result = await cleanEgress(join(tmpdir(), "orbit-egress-does-not-exist-" + crypto.randomUUID()));
  expect(result.removed).toEqual([]);
  expect(result.kept).toEqual([]);
  expect(result.refused).toEqual([]);
});

test("the egress root is the one the session code actually opens", () => {
  // The seam this defect hid behind: a sweep pointed at a root nothing writes to would pass every
  // test above and reclaim nothing in the product. Asserted against the same expression
  // src/session.ts builds its per-session directory from.
  const expected = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "sbar-orbit", "egress");
  expect(egressRoot()).toBe(expected);
});
