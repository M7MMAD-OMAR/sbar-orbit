/**
 * THE POLICY RATCHET, attacked at the resolution the existing suite holds fixed.
 *
 * `tests/policy.test.ts` and `tests/advisor.test.ts` sample the immune table and the rules with ONE
 * spelling of each destination: `/transfer`, `/account/password`, `/oauth/authorize`. Every
 * assertion there is about the canonical form, and the axis none of them varies is the ENCODING of
 * the path and the CASE of the rule's origin. A table that matches on the decoded segment set and a
 * table that matches on the raw one are the same table for every input those tests sample, and
 * different tables for a destination a page chooses.
 *
 * These drive the broker, because the disagreement worth finding is between `decide()` and its
 * CALLER: `session.ts` calls `decide(policy, type, destination)` with three arguments, and a rule
 * and an immune entry both have a fourth.
 */
import { test, expect } from "bun:test";
import { immuneMatch, decide, parsePolicy, narrow } from "../../src/policy";
import { openBroker, startFixture, act, type JournalView } from "./probe";
import { detectPlatform } from "../../src/platform";

const supported = (await detectPlatform()).browserBackendSupported;

/**
 * DEFECT, recorded rather than softened.
 *
 * `immuneMatch` splits `URL.pathname`, which keeps percent escapes verbatim: `new URL(
 * "https://bank.test/%74ransfer").pathname` is `/%74ransfer`. The segment set therefore holds
 * `%74ransfer`, the table looks for `transfer`, and the money movement entry does not fire. Every
 * ordinary web server decodes the path before routing, so `/%74ransfer` and `/transfer` are the same
 * endpoint to the service and two different endpoints to the immune set.
 *
 * This is the one table the project says nothing clears, so a spelling that walks past it is worth
 * more than any widening path: `docs/autonomy.md` describes matching a URL as a string as Orbit's
 * "equivalent mistake", and this is that mistake surviving inside the structural matcher.
 *
 * Remove `.failing` when `immuneMatch` decodes each segment before comparing.
 */
test("the immune set catches a percent encoded spelling of the same endpoint", () => {
  // The control: the canonical spelling is caught, so a table that refused everything would not pass.
  expect(immuneMatch("navigate", "https://bank.test/transfer", "POST")?.id).toBe("money-movement");
  // The attack. Three encodings of the same three tables.
  expect(immuneMatch("navigate", "https://bank.test/%74ransfer", "POST")?.id).toBe("money-movement");
  expect(immuneMatch("navigate", "https://mail.test/account/%70assword", "POST")?.id).toBe("credential-change");
  expect(immuneMatch("navigate", "https://id.test/%6Fauth/authorize?response_type=code&client_id=x")?.id).toBe("oauth-grant");
});

/**
 * The same defect at the altitude that matters, through the broker, with a real page that treats the
 * two spellings as one endpoint. A unit assertion on `immuneMatch` can be argued away as a matcher
 * detail; this one shows an autonomous session reaching a money movement endpoint and NOT being
 * contained, which is the property `docs/support-tiers.md` claims as Measured.
 *
 * Remove `.failing` with the one above.
 */
test.skipIf(!supported)("an autonomous session is contained by the immune set whichever spelling it navigates to", async () => {
  const broker = await openBroker("adversarial-immune");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "immune bypass",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    const session = created.sessionId;

    // The fixture decodes its path before answering, so both spellings are the same endpoint to it.
    await expect(act(broker.run, session, { type: "navigate", url: `${origin}/%74ransfer` }))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });

    const journal = await broker.run("session.journal", { sessionId: session }) as JournalView;
    const last = journal.entries.at(-1);
    expect(last?.outcome).toBe("deny");
    expect(last?.immuneId).toBe("money-movement");
    // Containment, not just refusal: an agent that has just attempted a money movement keeps `read`
    // and nothing else, which is what the existing session test asserts for the canonical spelling.
    expect(journal.policy.allow).toEqual(["read"]);
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 120000);

/**
 * DEFECT, and a narrowing rule that silently does nothing is worse than a missing one: the person
 * wrote it, the parser accepted it, `session.journal` reports it back in the policy, and it never
 * fires.
 *
 * `parsePolicy` validates `rule.origin` by calling `normaliseOrigin` for its throw and then stores
 * the caller's ORIGINAL string, while `ruleMatches` compares it against `new URL(url).origin`, which
 * is always normalised. So `origin: "example.test"` and `origin: "https://example.test/"` are
 * accepted as valid, reported as held, and match nothing. The session's own `origins` field does not
 * have this problem, because `parsePolicy` keeps the normalised value there, which is exactly why
 * the existing tests never sampled it: they only ever spell a rule origin the canonical way.
 *
 * Remove `.failing` when `parsePolicy` stores the normalised rule origin.
 */
test("a narrowing rule written with a bare host or a trailing slash still narrows", () => {
  const base = { mode: "autonomous" as const, allow: ["read", "navigate", "write"], origins: ["https://example.test"] };
  for (const spelling of ["example.test", "https://example.test/", "HTTPS://example.test"]) {
    const policy = parsePolicy({ ...base,
      rules: [{ id: "no-admin", verb: "navigate", origin: spelling, pathPrefix: "/admin", decision: "deny", reason: "admin is out of scope" }] });
    // Accepted, and reported back as held.
    expect(policy.rules?.[0]?.id).toBe("no-admin");
    expect({ spelling, outcome: decide(policy, "navigate", "https://example.test/admin/users").outcome })
      .toEqual({ spelling, outcome: "deny" });
  }
  // The control: spelled canonically it does fire, so this is about the spelling and not the rule.
  const canonical = parsePolicy({ ...base,
    rules: [{ id: "no-admin", verb: "navigate", origin: "https://example.test", pathPrefix: "/admin", decision: "deny", reason: "out of scope" }] });
  expect(decide(canonical, "navigate", "https://example.test/admin/users").outcome).toBe("deny");
});

/**
 * DEFECT at the contract seam, which is the thing unit tests on either side cannot see.
 *
 * `Rule.method` exists, `parsePolicy` accepts it, `ruleMatches` requires a method to match it, and
 * `src/session.ts:341` calls `decide(session.policy, action.type, destination)` with no fourth
 * argument. So every rule carrying a method is dead on the broker's own path: `ruleMatches` returns
 * false when `method === undefined`, and the rule fails OPEN. `tests/policy.test.ts` calls `decide`
 * directly and passes a method where it tests one, so both sides are green about a field that does
 * not work in the product.
 *
 * Remove `.failing` when a method bearing rule either fires or is refused at parse time as
 * unsupported for this backend.
 */
test.skipIf(!supported)("a rule that names a method is not dead on the broker's own path", async () => {
  const broker = await openBroker("adversarial-rule-method");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "dead rule",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"],
        rules: [{ id: "no-get-admin", verb: "navigate", method: "GET", decision: "deny", reason: "admin is out of scope" }] },
    }) as { sessionId: string };
    // A navigation IS a GET. Either the rule denies it, or the broker never had a way to say so and
    // the person's rule is decorative.
    await expect(act(broker.run, created.sessionId, { type: "navigate", url: `${origin}/admin` }))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 120000);

/** The ratchet itself, attacked with every shape of "give it back" the API offers. No defect found. */
test("no sequence of calls widens a live session, and the containment is terminal", async () => {
  const broker = await openBroker("adversarial-ratchet");
  const fixture = startFixture();
  try {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const other = "https://elsewhere.test";
    const created = await broker.run("session.create", {
      backend: "browser", agentName: "adversary", taskName: "ratchet",
      policy: { mode: "autonomous", origins: [origin], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string };
    const session = { sessionId: created.sessionId };

    // Narrowing to nothing, then asking for everything back, in every combination the method takes.
    // Each answer must be a SUBSET of what was held before it, never the union: naming a class the
    // policy no longer holds is how a widening would be spelled, and further narrowing is allowed.
    await broker.run("session.narrow", { ...session, allow: ["read"] });
    let held: { allow: string[]; origins: string[] | "any" } = { allow: ["read"], origins: [origin] };
    for (const attempt of [
      { allow: ["read", "navigate", "write", "irreversible"] },
      { origins: [origin, other] },
      { origins: [other], allow: ["write"] },
      { allow: ["read", "navigate", "write"], origins: [origin] },
    ]) {
      const result = await broker.run("session.narrow", { ...session, ...attempt }) as { policy: { allow: string[]; origins: string[] | "any" } };
      const previous = held;
      expect(result.policy.allow.filter(entry => !previous.allow.includes(entry))).toEqual([]);
      const origins = result.policy.origins;
      expect(origins).not.toBe("any");
      if (origins !== "any" && previous.origins !== "any")
        expect(origins.filter(entry => !previous.origins.includes(entry))).toEqual([]);
      expect(origins).not.toContain(other);
      held = result.policy;
    }
    // The first attempt asked for everything back while the session held `read`, so the ratchet
    // showing up as "still exactly read" there is the load bearing observation, not the union.
    expect(held.allow.length).toBeLessThanOrEqual(1);

    // A narrowing with neither field is refused rather than treated as a reset.
    await expect(broker.run("session.narrow", session)).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    // And there is no method that widens: the dispatcher's own list is the enumeration, so a new
    // widening verb would have to be added to it and would fail here.
    for (const method of ["session.widen", "session.policy", "session.setPolicy", "session.grant", "settings.write"])
      await expect(broker.run(method, { ...session, allow: ["write"] })).rejects.toBeInstanceOf(Error);

    // Creating a SECOND session with a wide policy must not touch the first one's: a shared module
    // level default that was mutated rather than copied would show up exactly here.
    await broker.run("session.create", { backend: "browser", agentName: "adversary", taskName: "wide" });
    const journal = await broker.run("session.journal", session) as JournalView;
    // Nothing the loop asked for was granted, so what is left is a subset of `read` and never more.
    expect(journal.policy.allow.filter(entry => entry !== "read")).toEqual([]);
    expect(journal.policy.origins).not.toBe("any");
    expect(journal.policy.origins).not.toContain(other);
    // And the wide session really is wide, so this is a test of isolation rather than of a broker
    // that narrowed everything.
    const sessions = await broker.run("session.list") as { policy: { origins: string[] | "any" } }[];
    expect(sessions.some(entry => entry.policy.origins === "any")).toBe(true);
    // And the containment applies to OBSERVATION, which is the half that protects the person rather
    // than the machine: a frame of a cloned profile's page is the contents of their accounts. `observe`
    // classifies as `read` and is dispatched on its own path, so it is the one action that could have
    // been left unpoliced while every other assertion here passed.
    await broker.run("session.narrow", { ...session, allow: [] });
    await expect(broker.run("session.observe", session)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // Presence stays, deliberately: it is metadata a desktop indicator polls and carries no page content.
    expect(await broker.run("session.presence", session)).toMatchObject({ location: expect.any(String) });
  } finally {
    await broker.close();
    fixture.stop(true);
  }
}, 180000);
/** `narrow` on the module's own exported defaults must not mutate them for the next session. */
test("narrowing a policy never mutates the module default the next session starts from", async () => {
  const { freshProfilePolicy, readOnlyPolicy } = await import("../../src/policy");
  const freshBefore = JSON.stringify(freshProfilePolicy);
  const readBefore = JSON.stringify(readOnlyPolicy);
  narrow(freshProfilePolicy, { origins: ["https://a.test"], allow: [] });
  narrow(readOnlyPolicy, { allow: [] });
  // A narrowed copy that shared its arrays with the default would leave the next session narrowed.
  expect(JSON.stringify(freshProfilePolicy)).toBe(freshBefore);
  expect(JSON.stringify(readOnlyPolicy)).toBe(readBefore);
  // And `parsePolicy({})` must still produce the untouched read only policy rather than the leftover.
  expect(parsePolicy({})).toEqual(readOnlyPolicy);
  // The deny list specifically, because `parsePolicy` spreads it: a shared array would grow.
  expect(parsePolicy({}).deny).toEqual(["irreversible"]);
  parsePolicy({}).deny.push("read");
  expect(readOnlyPolicy.deny).toEqual(["irreversible"]);
});
