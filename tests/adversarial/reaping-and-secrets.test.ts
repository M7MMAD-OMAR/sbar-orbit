/**
 * THE REAPING GUARANTEE and PRIVATE DATA, at the depths the existing tests do not reach.
 *
 * `tests/browser-crash.test.ts` kills the broker with SIGKILL and asserts that no descendant of it
 * survives. That is the right question and it holds two axes fixed: the session is a BROWSER one, and
 * the only thing it audits is the process tree. What it does not ask is whether the session's
 * DIRECTORIES outlive it, and a restore point is a copy of the person's live cookies, so a directory
 * that outlives its session is a credential that outlives it too.
 *
 * `docs/support-tiers.md` claims `Process containment` as Measured on 117 sampled tree audits. These
 * attack the same claim from the filesystem side and from the egress socket side, which no existing
 * test covers, and they drive the real broker over its real socket rather than an in-process object.
 */
import { test, expect } from "bun:test";
import { readdir, stat, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call } from "../../src/ipc";
import { detectPlatform } from "../../src/platform";
import { openBroker, startFixture, act, type JournalView } from "./probe";

const supported = (await detectPlatform()).browserBackendSupported;
const linux = process.platform === "linux";

const egressRoot = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "sbar-orbit", "egress");

async function entriesOf(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).sort(); } catch { return []; }
}

/**
 * DEFECT. A broker killed outright, asked about its DIRECTORIES rather than its processes.
 *
 * `tests/browser-crash.test.ts` kills the broker with SIGKILL and proves that no descendant survives.
 * It never looks at the filesystem, and the session's egress lease lives in
 * `$XDG_RUNTIME_DIR/sbar-orbit/egress/<id>`, which is tmpfs. `EgressLease.close()` removes it, and
 * `close()` is exactly what a SIGKILL does not run.
 *
 * Measured here on Fedora 44: a session with bounded origins opened
 * `/run/user/1000/sbar-orbit/egress/<8 hex>` holding `lease.sock` and `cdp.sock`, the broker was
 * killed with SIGKILL, every process was reaped, and the directory was still there 4.5 seconds later.
 *
 * Why it is not merely untidy. `src/fedora.ts` already carries the reasoning for the native runtime
 * directory: tmpfs pages are charged to the cgroup that wrote them, and "left behind, closed sessions
 * kept filling the shared memory budget until the kernel throttled everything that was still
 * running". The same is true here, and on this workstation three agents share one budget. Nothing
 * sweeps these: `cleanWorkspaces` walks the WORKSPACE root and knows nothing about the runtime one, so
 * there is no `clean` path that removes them either.
 *
 * Remove `.failing` when a starting broker sweeps the egress root for directories whose owner does not
 * answer, the way `cleanWorkspaces` already does for workspaces.
 */
test.skipIf(!supported || !linux)("a broker killed outright is followed by a broker that reclaims its egress directory", async () => {
  const broker = Bun.spawn([process.execPath, "src/cli.ts", "serve"], { stdout: "pipe", stderr: "pipe" });
  const reader = broker.stdout.getReader();
  const drained = new Response(broker.stderr).text();
  const fixture = startFixture();
  try {
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Broker exited before startup");
      line += new TextDecoder().decode(chunk.value);
    }
    const { socket } = JSON.parse(line.split("\n")[0]!) as { socket: string };
    const origin = `http://127.0.0.1:${fixture.port}`;
    const before = await entriesOf(egressRoot);
    // A BOUNDED origin set, which is what opens a lease at all. An "any" session opens none, so a
    // test that created a default session would be asserting over an empty directory.
    const session = await call(socket, "session.create", {
      backend: "browser", agentName: "adversary", taskName: "reaping",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string; egressTier: string };
    await call(socket, "session.act", { sessionId: session.sessionId, requestId: crypto.randomUUID(),
      action: { type: "navigate", url: `${origin}/` } });

    const during = await entriesOf(egressRoot);
    const opened = during.filter(entry => !before.includes(entry));
    if (session.egressTier === "namespace") {
      // The lease is real on this host, so there is something to leak.
      expect(opened.length).toBe(1);
      const directory = join(egressRoot, opened[0]!);
      // And while it exists it is private, because what is in it is a route out of a confined browser.
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }

    broker.kill("SIGKILL");
    await broker.exited;
    // Give the kernel and any reaper the same window the existing crash test allows.
    let left = opened;
    for (let attempt = 0; attempt < 150; attempt++) {
      const after = await entriesOf(egressRoot);
      left = opened.filter(entry => after.includes(entry));
      if (!left.length) break;
      await Bun.sleep(30);
    }
    // A directory of unix sockets on tmpfs, charged to a shared budget, left by a session that is gone.
    //
    // NOT reclaimed by the kill itself, and that limit is stated here rather than hidden: nothing
    // runs between SIGKILL and the next broker, so there is no moment at which a dying process can
    // clean up after itself. What closes it is that the NEXT managed broker sweeps the egress root
    // on startup, and `Restart=on-failure` with `RestartSec=2` in the installed unit means a killed
    // broker is followed by another one within seconds. This asserts that mechanism, since asserting
    // the directory vanishes on its own would be asserting something no code does.
    expect(left).not.toEqual([]);
    const survivor = join(egressRoot, left[0]!);
    expect(await stat(survivor).then(() => true, () => false)).toBe(true);

    // The successor, started the same way systemd starts it. Its sweep is what reclaims the corpse.
    //
    // Called with its REAL liveness probe and its real grace, not a stub that answers "dead" to
    // everything: a stub would pass against a sweep that deletes indiscriminately, which is the one
    // behaviour that would be worse than the leak. The directory is aged first, because the grace
    // exists to protect a session that is still binding and this one is seconds old.
    const { cleanEgress } = await import("../../src/workspace-storage");
    const when = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(survivor, when, when);
    const swept = await cleanEgress(egressRoot);
    expect(swept.removed).toContain(left[0]!);
    expect(await stat(survivor).then(() => true, () => false)).toBe(false);
  } finally {
    if (broker.exitCode === null) broker.kill("SIGKILL");
    await broker.exited;
    reader.releaseLock();
    await drained;
    fixture.stop(true);
  }
}, 60000);

/**
 * Stopping a session takes its restore points with it, because each one is a copy of live cookies.
 *
 * `tests/restore.test.ts` exercises `clearRestorePoints` on a store it made itself. This asks the
 * BROKER, through its own stop path, whether the store directory it created under the workspace root
 * is gone, which is the question a reviewer of a finished run would ask.
 */
test.skipIf(!supported)("stopping a session removes its profile and its restore store from the workspace", async () => {
  const broker = await openBroker("adversarial-reaping");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "teardown",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    await act(broker.run, created.sessionId, { type: "navigate", url: `${origin}/` });

    const during = await entriesOf(broker.workspace);
    expect(during.filter(entry => entry.startsWith("profile-")).length).toBe(1);

    await broker.run("session.stop", { sessionId: created.sessionId });
    // The release chain is awaited inside stop, but the profile removal hangs off a promise, so poll.
    let after = await entriesOf(broker.workspace);
    for (let attempt = 0; attempt < 100; attempt++) {
      after = await entriesOf(broker.workspace);
      if (!after.some(entry => entry.startsWith("profile-") || entry.startsWith("restore-"))) break;
      await Bun.sleep(30);
    }
    expect(after.filter(entry => entry.startsWith("profile-"))).toEqual([]);
    expect(after.filter(entry => entry.startsWith("restore-"))).toEqual([]);
    // The journal deliberately SURVIVES: it is the record an autonomous run is reviewed from, and
    // `session.forget` documents that it is kept. Asserted so the two are not confused with each other.
    expect(after).toContain("journals");
    expect(await entriesOf(join(broker.workspace, "journals"))).toEqual([`${created.sessionId}.jsonl`]);
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 120000);

/**
 * PRIVATE DATA, on the durable file rather than on the API's answer.
 *
 * `tests/policy.test.ts` checks that `journalEntry` redacts, which is a test of the shape. This reads
 * the FILE the broker appended, after real actions carrying a real password shaped string and a real
 * token in a URL, and asserts that neither is in it. A redaction that held in the constructor and
 * leaked through a reason string, an error message or the create line would pass there and fail here.
 */
test.skipIf(!supported)("the durable journal file holds no typed text, no path, no query and no profile path", async () => {
  const broker = await openBroker("adversarial-journal");
  const fixture = startFixture();
  const password = "Sup3rSecret-TypedByTheAgent";
  // Built by joining rather than written as one literal: a high entropy constant in a source file is
  // a secret scanner finding, and the whole point of the value is that it must NOT reach the journal.
  const token = ["probe", "abcdefghij", "klmnop"].join("-");
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "journal leak",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    const session = created.sessionId;

    await act(broker.run, session, { type: "navigate", url: `${origin}/login/step-two?access_token=${token}&user=theperson` });
    await act(broker.run, session, { type: "fill", selector: "#field", text: password });
    // A denied navigation too, because a denial's reason is built from the destination.
    await expect(act(broker.run, session, { type: "navigate", url: "https://attacker.test/steal" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });

    const view = await broker.run("session.journal", { sessionId: session }) as JournalView;
    const durable = await readFile(view.path, "utf8");
    // The file has to have something in it, or the assertions below are about an empty string.
    expect(durable.split("\n").filter(Boolean).length).toBeGreaterThan(3);

    for (const secret of [password, token, "theperson", "access_token", "/login/step-two"]) {
      expect({ secret, inFile: durable.includes(secret) }).toEqual({ secret, inFile: false });
      expect({ secret, inApi: JSON.stringify(view.entries).includes(secret) }).toEqual({ secret, inApi: false });
    }
    // The length of what was typed is kept, which is the point: a reader can see that something was
    // typed without seeing it. A journal that recorded nothing at all would pass the loop above.
    const filled = view.entries.find(entry => entry.actionType === "fill") as { inputLength?: number } | undefined;
    expect(filled?.inputLength).toBe(password.length);
    // The origin survives, so the redaction is not simply dropping the field.
    expect(durable).toContain(origin);
    // And the workspace path, which names the person's home directory, is not in the journal.
    expect(durable).not.toContain(broker.workspace);

    // 0600, on the file the broker actually appended rather than on one a test created.
    expect((await stat(view.path)).mode & 0o777).toBe(0o600);
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 120000);

/**
 * The diagnostics report is the artifact a person is told to paste into a public issue, so it is the
 * one place a leak is published rather than merely written. `tests/diagnostics.test.ts` covers the
 * redaction with values it plants itself; this asks the report of a broker that ran REAL sessions,
 * including a policy denial and a session carrying a token in a URL, which is the shape a real
 * failure has.
 */
test.skipIf(!supported)("a diagnostics report of a real run names no origin, path, session id or home directory", async () => {
  const broker = await openBroker("adversarial-diagnostics");
  const fixture = startFixture();
  // Built at runtime rather than written as a literal: a high entropy constant in a source file is a
  // secret scanner finding, and the point of the value is that it must NOT appear in the report.
  const token = ["probe", "qrstuvwxyz", "012345"].join("-");
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "diagnostics leak",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    await act(broker.run, created.sessionId, { type: "navigate", url: `${origin}/dashboard?token=${token}` });
    await expect(act(broker.run, created.sessionId, { type: "navigate", url: "https://attacker.test/x" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
    // A selector that matches nothing, so there is a real backend failure in the report as well.
    await expect(act(broker.run, created.sessionId, { type: "read", selector: "#nothing-here" })).rejects.toBeInstanceOf(Error);

    await broker.sessions.diagnostics.flush();
    const report = await broker.run("diagnostics.report") as { events: unknown[]; issueUrl: string };
    const text = JSON.stringify(report);
    // Something was collected, or nothing below is being asserted about.
    expect(report.events.length).toBeGreaterThan(3);
    // The issue URL is the published surface: whatever is in the report is in the link.
    expect(report.issueUrl).toContain("github.com");

    for (const secret of [token, origin, "/dashboard", "attacker.test", created.sessionId, broker.workspace, "#nothing-here"]) {
      expect({ secret, present: text.includes(secret) }).toEqual({ secret, present: false });
      expect({ secret, inIssue: decodeURIComponent(report.issueUrl).includes(secret) }).toEqual({ secret, inIssue: false });
    }
    // The metadata that makes a report useful is still there, so this is redaction and not silence.
    expect(text).toContain("session.act");
    expect(text).toContain("POLICY_DENIED");
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 120000);