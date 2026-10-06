import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBackend } from "../src/browser";
import type { CloneResult } from "../src/clone";
import * as egress from "../src/egress";
import type { PlatformCapabilities } from "../src/platform";
import { AccountLease } from "../src/profiles";
import * as restore from "../src/restore";
const { Sessions }: typeof import("../src/session") = await import(process.env.ORBIT_SESSION_RELEASE_SOURCE || "../src/session");

async function fixture(failures: string[], releaseGate = Promise.resolve()) {
  const root = await mkdtemp(join(tmpdir(), "orbit-session-release-"));
  const released: string[] = [];
  const release = async (name: string) => {
    released.push(name);
    await releaseGate;
    if (failures.includes(name)) throw new Error(`fixture ${name} release failed`);
  };
  let exited = () => {};
  const backend = {
    surface: { width: 1280, height: 800 }, capabilities: [],
    onClose: (listener: () => void) => { exited = listener; },
    close: async () => { exited(); },
  } as unknown as BrowserBackend;
  const spies = [
    spyOn(restore, "createSubvolume").mockResolvedValue(true),
    spyOn(restore, "clearRestorePoints").mockImplementation(async store => {
      await release("restore");
      await rm(store, { recursive: true, force: true });
      return { removed: 0, left: [] };
    }),
    spyOn(BrowserBackend, "create").mockResolvedValue(backend),
    spyOn(egress, "openEgressLease").mockResolvedValue({
      tier: "namespace", launch: { executable: "fixture", args: [] }, endpointPort: 0,
      refused: () => [], close: () => release("egress"),
    }),
    spyOn(AccountLease, "acquire").mockResolvedValue({
      name: "fixture", restore: async () => undefined, onLost: () => {},
      release: () => release("account"),
    } as unknown as AccountLease),
  ];
  class FixtureSessions extends Sessions {
    protected override capabilities() { return Promise.resolve({ confinedEgress: true } as PlatformCapabilities); }
    protected override cloneProfileForSession = async (): Promise<CloneResult> => ({
      sourceProfile: "fixture", reflinked: false, readOnly: [],
      launch: { executable: "fixture" }, close: () => release("clone"),
    });
  }
  const sessions = new FixtureSessions(root, join(root, "accounts"));
  const created = await sessions.create({ backend: "browser",
    ...(failures.includes("account") ? { accountName: "fixture" } : { cloneOf: "fixture" }),
    policy: { mode: "autonomous", origins: ["https://example.test"], allow: ["read", "navigate"] },
  }) as { sessionId: string };
  const session = { sessionId: created.sessionId };
  const store = join(root, `restore-${session.sessionId}`);
  await mkdir(store);
  return { root, sessions, session, released, exited: () => exited(),
    dispose: async () => {
      await sessions.close().catch(() => {});
      for (const spy of spies) spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const ending of ["stop", "crash"] as const) {
  test.each(["account", "clone", "egress"])(`${ending} attempts remaining releases after a %s failure`, async failed => {
    const f = await fixture([failed]);
    try {
      if (ending === "crash") f.exited();
      await expect(f.sessions.dispatch({ method: "session.stop", params: f.session }))
        .rejects.toMatchObject({ code: "BACKEND_ERROR" });
      expect(f.released).toEqual([failed === "account" ? "account" : "clone", "egress", "restore"]);
      expect((await readdir(f.root)).filter(name => name.startsWith("profile-"))).toEqual([]);
      await expect(f.sessions.close()).rejects.toThrow(`fixture ${failed} release failed`);
    } finally { await f.dispose(); }
  });
}

test("multiple release failures remain visible after all cleanup attempts", async () => {
  const f = await fixture(["clone", "egress"]);
  try {
    await expect(f.sessions.dispatch({ method: "session.stop", params: f.session }))
      .rejects.toMatchObject({ code: "BACKEND_ERROR" });
    const failure = await f.sessions.close().catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      "fixture clone release failed", "fixture egress release failed",
    ]);
    expect(f.released).toEqual(["clone", "egress", "restore"]);
    expect((await readdir(f.root)).filter(name => name.startsWith("profile-"))).toEqual([]);
  } finally { await f.dispose(); }
});

test("forget waits for successful cleanup and retains a failed cleanup session", async () => {
  let allowRelease = () => {};
  const gate = new Promise<void>(resolve => { allowRelease = resolve; });
  const f = await fixture(["clone"], gate);
  try {
    f.exited();
    let settled = false;
    const forgotten = f.sessions.dispatch({ method: "session.forget", params: f.session })
      .then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    const outcome = forgotten.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    allowRelease();
    expect(await outcome).toMatchObject({ code: "BACKEND_ERROR" });
    expect(await f.sessions.dispatch({ method: "session.list" })).toContainEqual(expect.objectContaining(f.session));
    await expect(f.sessions.close()).rejects.toThrow("fixture clone release failed");
  } finally { allowRelease(); await f.dispose(); }
});

test("forget removes a successfully reaped session and remains idempotent", async () => {
  const f = await fixture([]);
  try {
    f.exited();
    expect(await f.sessions.dispatch({ method: "session.forget", params: f.session }))
      .toEqual({ ...f.session, forgotten: true });
    expect(f.released).toEqual(["clone", "egress", "restore"]);
    expect((await readdir(f.root)).filter(name => name.startsWith("profile-"))).toEqual([]);
    expect(await f.sessions.dispatch({ method: "session.forget", params: f.session }))
      .toEqual({ ...f.session, forgotten: false });
  } finally { await f.dispose(); }
});
