import { expectPrivatePath } from "../private-path";
/**
 * CROSS SESSION LEAKAGE, raced genuinely in parallel.
 *
 * The existing concurrency evidence is a sequential loop of 100 submissions per browser
 * (`docs/experiment.md`), which passes against vulnerable code because nothing is ever in flight at
 * once. The axis every existing isolation test holds fixed is TIME: one session acts, then the other.
 * These fire the calls with `Promise.all` so the broker's own ordering is what is under test, and
 * each one is written so that the interleaving it forbids would be observable.
 */
import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { detectPlatform } from "../../src/platform";
import { openBroker, startFixture, act, type JournalView } from "./probe";

const supported = (await detectPlatform()).browserBackendSupported;

test.skipIf(!supported)("two sessions created in the same instant get separate profiles, journals and storage", async () => {
  const broker = await openBroker("adversarial-parallel");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const policy = { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] };
    // Genuinely at once. The broker serialises backend starts internally; what must not be shared is
    // anything it decided before that queue.
    const [a, b] = await Promise.all([
      broker.run("session.create", { backend: "browser", agentName: "adversary-a", taskName: "race", policy }),
      broker.run("session.create", { backend: "browser", agentName: "adversary-b", taskName: "race", policy }),
    ]) as { sessionId: string }[];
    if (!a || !b) throw new Error("Both sessions were expected");
    expect(a.sessionId).not.toBe(b.sessionId);

    // Two profile directories, not one shared: a single profile would mean one cookie jar.
    const profiles = (await readdir(broker.workspace)).filter(entry => entry.startsWith("profile-"));
    expect(profiles.length).toBe(2);

    // Two journal files, each 0600, each holding only its own session id.
    const journals = await readdir(join(broker.workspace, "journals"));
    expect(journals.sort()).toEqual([`${a.sessionId}.jsonl`, `${b.sessionId}.jsonl`].sort());
    for (const name of journals)
      await expectPrivatePath(join(broker.workspace, "journals", name), 0o600);

    // Now race the actions themselves, both writing to storage under the same origin with different
    // values. A shared context would leave one value visible to both.
    await Promise.all([
      act(broker.run, a.sessionId, { type: "navigate", url: `${origin}/a` }),
      act(broker.run, b.sessionId, { type: "navigate", url: `${origin}/b` }),
    ]);
    await Promise.all([
      act(broker.run, a.sessionId, { type: "fill", selector: "#field", text: "value-from-a" }),
      act(broker.run, b.sessionId, { type: "fill", selector: "#field", text: "value-from-b" }),
    ]);
    const [readA, readB] = await Promise.all([
      act(broker.run, a.sessionId, { type: "read", selector: "#result" }),
      act(broker.run, b.sessionId, { type: "read", selector: "#result" }),
    ]) as { text: string }[];
    // Each session sees its OWN page, which is what separate contexts mean.
    expect(readA?.text).toBe("/a");
    expect(readB?.text).toBe("/b");

    // And neither journal mentions the other session.
    for (const [session, other] of [[a, b], [b, a]] as const) {
      const journal = await broker.run("session.journal", { sessionId: session.sessionId }) as JournalView;
      expect(journal.entries.length).toBeGreaterThan(2);
      const text = JSON.stringify(journal.entries);
      expect(text).toContain(session.sessionId);
      expect(text).not.toContain(other.sessionId);
      // Strictly increasing and unique per session. A shared counter across sessions would show up
      // here as a jump; a duplicate would show up as a collision. The numbering is not dense, and
      // that is by design: `record` uses `journal.length + 1` while the create line is 0, so 1 is
      // never used.
      const sequences = journal.entries.map(entry => entry.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);
    }
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 180000);

/**
 * The profile lease, raced. `session.create` checks `this.leases.has(lease)` and then adds it, and
 * everything between those two lines is synchronous, so the lease is genuinely safe. That is worth
 * PROVING with concurrent calls rather than asserting from a reading of the code, and this test was
 * shown to go red when the check is removed.
 *
 * Fired eight ways at once rather than two: a check-then-set hole widens with contention, and a pair
 * can win by luck on a machine whose scheduler happens to serialise them.
 */
test.skipIf(!supported)("only one of eight simultaneous claims on one profile key wins", async () => {
  const broker = await openBroker("adversarial-lease");
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
      broker.run("session.create", { backend: "browser", agentName: "adversary", taskName: "lease race", profileKey: "contended" })));
    const won = attempts.filter(attempt => attempt.status === "fulfilled");
    const lost = attempts.filter(attempt => attempt.status === "rejected");
    expect(won.length).toBe(1);
    expect(lost.length).toBe(7);
    // And every loss says PROFILE_BUSY, not some generic failure: a caller retrying on the wrong
    // code is a caller that never retries.
    for (const attempt of lost)
      expect((attempt as PromiseRejectedResult).reason).toMatchObject({ code: "PROFILE_BUSY" });

    // The lease is released when the session ends, so the key becomes claimable again exactly once.
    const winner = (won[0] as PromiseFulfilledResult<{ sessionId: string }>).value;
    await broker.run("session.stop", { sessionId: winner.sessionId });
    const again = await broker.run("session.create", { backend: "browser", profileKey: "contended" }) as { sessionId: string };
    expect(again.sessionId).not.toBe(winner.sessionId);
  } finally {
    await broker.close();
  }
}, 180000);

/**
 * A duplicate request id, raced. `act` looks the id up and then sets it, with an `await` nowhere in
 * between, so a retry cannot become a second click. Proved concurrently, since a sequential call
 * proves only that the map works.
 */
test.skipIf(!supported)("one request id fired ten times at once performs one action", async () => {
  const broker = await openBroker("adversarial-request-id");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "retry race",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    await act(broker.run, created.sessionId, { type: "navigate", url: `${origin}/` });

    const requestId = crypto.randomUUID();
    const action = { type: "click", selector: "#go" };
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      broker.run("session.act", { sessionId: created.sessionId, requestId, action })));
    // All ten resolve, because a retry is an answer and not an error.
    expect(results.length).toBe(10);

    const journal = await broker.run("session.journal", { sessionId: created.sessionId }) as JournalView;
    const clicks = journal.entries.filter(entry => entry.actionType === "click");
    // One journalled click for one request id, however many callers asked.
    expect(clicks.length).toBe(1);

    // The same id with DIFFERENT arguments is a conflict, not a second action.
    await expect(broker.run("session.act", { sessionId: created.sessionId, requestId, action: { type: "click", selector: "#field" } }))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    const after = await broker.run("session.journal", { sessionId: created.sessionId }) as JournalView;
    expect(after.entries.filter(entry => entry.actionType === "click").length).toBe(1);
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 180000);

/**
 * A narrowing raced against the action it is meant to forbid.
 *
 * This is the interleaving that matters for the ratchet: if `narrow` and `act` can cross, an agent
 * whose policy was just tightened gets one more action through. Both orders are acceptable answers,
 * because the calls genuinely race; what is NOT acceptable is an action allowed AFTER the journal
 * records the narrowing, and that is what is asserted, by sequence rather than by wall clock.
 */
test.skipIf(!supported)("an action never lands after the narrowing that forbade it", async () => {
  const broker = await openBroker("adversarial-narrow-race");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "narrow race",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    const session = created.sessionId;
    await act(broker.run, session, { type: "navigate", url: `${origin}/` });

    // Fired together. Either the fill is decided before the narrowing or it is refused by it.
    const [filled] = await Promise.allSettled([
      act(broker.run, session, { type: "fill", selector: "#field", text: "raced" }),
      broker.run("session.narrow", { sessionId: session, allow: ["read"] }),
    ]);

    const journal = await broker.run("session.journal", { sessionId: session }) as JournalView;
    const narrowing = journal.entries.findIndex(entry => entry.actionType === "session.narrow");
    expect(narrowing).toBeGreaterThan(-1);
    const allowedAfter = journal.entries.slice(narrowing + 1)
      .filter(entry => entry.actor === "agent" && entry.outcome === "allow" && entry.actionType !== "observe");
    expect(allowedAfter).toEqual([]);

    // And once the narrowing is recorded, the class is gone for good even though the fill may have won.
    expect(["fulfilled", "rejected"]).toContain(filled?.status);
    await expect(act(broker.run, session, { type: "fill", selector: "#field", text: "after" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 180000);
