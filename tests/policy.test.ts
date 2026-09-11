import { test, expect } from "bun:test";
import { classify, decide, freshProfilePolicy, journalEntry, narrow, parsePolicy, readOnlyPolicy, requireBoundedOrigins, type SessionPolicy } from "../src/policy";

const autonomous = (over: Partial<SessionPolicy> = {}): SessionPolicy => ({
  mode: "autonomous", origins: ["https://example.test"], allow: ["read", "navigate", "write"], deny: ["irreversible"], ...over,
});

test("an unknown action is the most consequential class, never the least", () => {
  expect(classify("read")).toBe("read");
  expect(classify("navigate")).toBe("navigate");
  expect(classify("click")).toBe("write");
  // A vocabulary grows. The default for something Orbit has not seen must be a refusal.
  expect(classify("transfer-funds")).toBe("irreversible");
  expect(classify("")).toBe("irreversible");
});

test("an autonomous session never asks, it decides", () => {
  const policy = autonomous();
  expect(decide(policy, "read")).toEqual({ outcome: "allow" });
  const denied = decide(policy, "launch");
  expect(denied.outcome).toBe("deny");
  // The whole point: no outcome of an autonomous session is "wait for a person".
  for (const action of ["read", "click", "navigate", "launch", "unknown-thing"])
    expect(decide(policy, action, "https://example.test/x").outcome).not.toBe("ask");
});

test("a supervised session asks where an autonomous one refuses", () => {
  const supervised: SessionPolicy = { ...autonomous(), mode: "supervised", allow: ["read"] };
  expect(decide(supervised, "click").outcome).toBe("ask");
  expect(decide(autonomous({ allow: ["read"] }), "click").outcome).toBe("deny");
});

test("a deny is absolute and outranks an allow that names the same class", () => {
  const contradictory = autonomous({ allow: ["read", "irreversible"], deny: ["irreversible"] });
  const decision = decide(contradictory, "launch");
  expect(decision.outcome).toBe("deny");
  if (decision.outcome === "deny") expect(decision.reason).toContain("not overridable");
});

test("navigation is bounded by the allowlist, whatever a page says", () => {
  const policy = autonomous({ origins: ["https://example.test", "https://docs.example.test"] });
  expect(decide(policy, "navigate", "https://example.test/page").outcome).toBe("allow");
  expect(decide(policy, "navigate", "https://docs.example.test/a/b?c=d").outcome).toBe("allow");
  // The injection case: the page asks the agent to go somewhere else.
  const off = decide(policy, "navigate", "https://attacker.test/steal");
  expect(off.outcome).toBe("deny");
  if (off.outcome === "deny") expect(off.reason).toContain("allowlist");
  // A near miss is still a miss: scheme, host and port each matter.
  expect(decide(policy, "navigate", "http://example.test/page").outcome).toBe("deny");
  expect(decide(policy, "navigate", "https://example.test:8443/page").outcome).toBe("deny");
  expect(decide(policy, "navigate", "https://evil.example.test.attacker.test/").outcome).toBe("deny");
  expect(decide(policy, "navigate", "not a url").outcome).toBe("deny");
  // A tab opened with no destination stays inside the session, so there is nothing to check.
  expect(decide(policy, "open-tab").outcome).toBe("allow");
});

test("a policy cannot be widened, only narrowed", () => {
  const policy = autonomous({ origins: ["https://a.test", "https://b.test"], allow: ["read", "navigate", "write"] });
  const tighter = narrow(policy, { origins: ["https://a.test"], allow: ["read"] });
  expect(tighter.origins).toEqual(["https://a.test"]);
  expect(tighter.allow).toEqual(["read"]);
  // Naming something the policy never held does not add it.
  const attempted = narrow(policy, { origins: ["https://attacker.test"], allow: ["irreversible"] });
  expect(attempted.origins).toEqual([]);
  expect(attempted.allow).toEqual([]);
  // The original is untouched, so a narrowed view cannot leak back.
  expect(policy.origins).toEqual(["https://a.test", "https://b.test"]);
});

test("parsing refuses the spellings that would make the allowlist meaningless", () => {
  expect(() => parsePolicy({ origins: ["*"] })).toThrow();
  expect(() => parsePolicy({ origins: ["https://*.example.test"] })).toThrow();
  expect(() => parsePolicy({ origins: ["file:///etc/passwd"] })).toThrow();
  expect(() => parsePolicy({ allow: ["read", "sudo"] })).toThrow();
  expect(() => parsePolicy({ mode: "yolo" })).toThrow();
  // Allowing navigation with nowhere to go is a contradiction, caught at creation not at use.
  expect(() => parsePolicy({ allow: ["navigate"] })).toThrow();
  // Origins are normalised, deduplicated, and a bare host becomes https.
  const parsed = parsePolicy({ mode: "autonomous", origins: ["example.test", "https://example.test/ignored/path"], allow: ["read", "navigate"] });
  expect(parsed.origins).toEqual(["https://example.test"]);
  expect(parsed.mode).toBe("autonomous");
});

test("the default policy looks and does not touch", () => {
  expect(readOnlyPolicy.allow).toEqual(["read"]);
  expect(readOnlyPolicy.deny).toEqual(["irreversible"]);
  expect(readOnlyPolicy.origins).toEqual([]);
  expect(decide(readOnlyPolicy, "click").outcome).toBe("ask");
  expect(decide(readOnlyPolicy, "navigate", "https://anywhere.test").outcome).toBe("deny");
  expect(parsePolicy({})).toEqual(readOnlyPolicy);

  // Reaching the irreversible class takes two deliberate statements, not one. Naming it in allow is
  // not enough, because an omitted deny still carries it.
  expect(decide(parsePolicy({ mode: "autonomous", allow: ["read", "irreversible"] }), "launch").outcome).toBe("deny");
  expect(decide(parsePolicy({ mode: "autonomous", allow: ["read", "irreversible"], deny: [] }), "launch").outcome).toBe("allow");
});

test("the journal records what happened without recording what was in it", () => {
  const entry = journalEntry({
    sequence: 4, sessionId: "s-1", actor: "agent", actionType: "fill",
    decision: { outcome: "allow" }, url: "https://example.test/login?token=SECRET&user=person",
    inputLength: 24,
  });
  expect(entry).toEqual({
    sequence: 4, sessionId: "s-1", actor: "agent", actionType: "fill", actionClass: "write",
    origin: "https://example.test", outcome: "allow", inputLength: 24,
  });
  const serialised = JSON.stringify(entry);
  // A full URL carries tokens and identifiers in its query, and typed text is a password.
  expect(serialised).not.toContain("SECRET");
  expect(serialised).not.toContain("person");
  expect(serialised).not.toContain("/login");

  const refused = journalEntry({
    sequence: 5, sessionId: "s-1", actor: "agent", actionType: "navigate",
    decision: { outcome: "deny", reason: "not in the allowlist" }, url: "https://attacker.test/x",
  });
  expect(refused.outcome).toBe("deny");
  expect(refused.reason).toBe("not in the allowlist");
  expect(refused.origin).toBe("https://attacker.test");
});

test("a fresh profile session is unbounded, a session with real logins cannot be", () => {
  // Every session Orbit creates today starts from an empty profile, so there is nothing to steer it
  // toward and bounding it would only break the agent.
  expect(freshProfilePolicy.origins).toBe("any");
  expect(decide(freshProfilePolicy, "navigate", "https://anywhere.test/x").outcome).toBe("allow");
  expect(decide(freshProfilePolicy, "launch").outcome).toBe("deny");

  // The moment a session carries the person's real logins, unbounded origins are refused.
  expect(() => requireBoundedOrigins(freshProfilePolicy)).toThrow();
  expect(() => requireBoundedOrigins(parsePolicy({ origins: [], allow: ["read"] }))).toThrow();
  expect(requireBoundedOrigins(parsePolicy({ mode: "autonomous", origins: ["https://mail.example.test"], allow: ["read", "navigate", "write"] })))
    .toEqual(["https://mail.example.test"]);

  // "any" can be narrowed to a named list, and a named list can never become "any".
  expect(narrow(freshProfilePolicy, { origins: ["https://a.test"] }).origins).toEqual(["https://a.test"]);
  expect(narrow(parsePolicy({ origins: ["https://a.test"], allow: ["read", "navigate"] }), {}).origins).toEqual(["https://a.test"]);
});

test("the lease is a property of the session, and a page cannot be an exception to it", () => {
  // Recorded here because the enforcement itself is measured in experiments/origin-lease.ts: the
  // broker's check governs what the AGENT asks for, and it governs nothing a page does on its own.
  // Both depths read the same allowlist, so narrowing one narrows the other.
  const policy = parsePolicy({ mode: "autonomous", origins: ["https://a.test"], allow: ["read", "navigate", "write"] });
  expect(policy.origins).toEqual(["https://a.test"]);
  expect(decide(policy, "navigate", "https://b.test").outcome).toBe("deny");
  // A session with no credentials installs no lease, which is what "any" means to the backend.
  expect(freshProfilePolicy.origins).toBe("any");
});
