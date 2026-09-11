import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consultAdvisor } from "../src/advisor";
import { decide, immuneMatch, immuneSet, journalEntry, narrow, parsePolicy, type SessionPolicy } from "../src/policy";

/** An advisor is any executable that reads one JSON object and writes one. These are the shapes. */
async function advisorScript(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "orbit-advisor-"));
  const path = join(directory, "advisor.sh");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const pending = journalEntry({
  sequence: 1, sessionId: "s-1", actor: "agent", actionType: "click",
  decision: { outcome: "consult", reason: "checked", ruleId: "r1" }, url: "https://example.test/x",
});
const ask = (command: string[], timeoutMs = 5000) =>
  consultAdvisor({ command, timeoutMs }, { pending, tail: [], reason: "checked", ruleId: "r1" });

test("an advisor that answers allow, allows; one that answers deny, denies", async () => {
  const yes = await ask([await advisorScript(`cat >/dev/null; echo '{"decision":"allow","reason":"fine"}'`)]);
  expect(yes.decision.outcome).toBe("allow");
  expect(yes.decidedBy).toBe("advisor-allowed");

  const no = await ask([await advisorScript(`cat >/dev/null; echo '{"decision":"deny","reason":"not this one"}'`)]);
  expect(no.decision.outcome).toBe("deny");
  expect(no.decidedBy).toBe("advisor-denied");
  if (no.decision.outcome === "deny") {
    expect(no.decision.reason).toBe("not this one");
    // The rule that caused the consult is carried through, so a denial traces to the line responsible.
    expect(no.decision.ruleId).toBe("r1");
  }
});

test("every way an advisor can fail is a deny, and the reason is the failure", async () => {
  const cases: [string, string, string][] = [
    ["a non zero exit", `cat >/dev/null; exit 3`, "advisor-failed"],
    ["output that is not JSON", `cat >/dev/null; echo 'not json at all'`, "advisor-unparsable"],
    ["JSON that is not an object", `cat >/dev/null; echo '["allow"]'`, "advisor-unparsable"],
    ["an answer that is neither allow nor deny", `cat >/dev/null; echo '{"decision":"maybe"}'`, "advisor-unparsable"],
    ["an answer that tries to ask a person", `cat >/dev/null; echo '{"decision":"ask"}'`, "advisor-unparsable"],
    ["a crash before answering", `kill -9 $$`, "advisor-failed"],
    ["no output at all", `cat >/dev/null; exit 0`, "advisor-unparsable"],
  ];
  for (const [name, body, expected] of cases) {
    const answer = await ask([await advisorScript(body)]);
    expect(`${name}: ${answer.decision.outcome}`).toBe(`${name}: deny`);
    expect(`${name}: ${answer.decidedBy}`).toBe(`${name}: ${expected}`);
  }

  // A command that does not exist, and one that is empty.
  expect((await ask(["/nonexistent/advisor"])).decision.outcome).toBe("deny");
  expect((await ask([])).decision.outcome).toBe("deny");
});

test("a hung advisor denies on the clock rather than stalling the session", async () => {
  const started = Date.now();
  const answer = await ask([await advisorScript(`cat >/dev/null; sleep 30`)], 400);
  const elapsed = Date.now() - started;
  expect(answer.decision.outcome).toBe("deny");
  expect(answer.decidedBy).toBe("advisor-timeout");
  // A stalled session is the thing autonomy exists to avoid, so the clock is part of the contract.
  expect(elapsed).toBeLessThan(5000);
});

test("the advisor is told the record and nothing that could carry an injection", async () => {
  const seen = await mkdtemp(join(tmpdir(), "orbit-advisor-saw-"));
  const capture = join(seen, "input.json");
  const answer = await ask([await advisorScript(`cat >${capture}; echo '{"decision":"allow"}'`)]);
  expect(answer.decision.outcome).toBe("allow");
  const given = JSON.parse(await Bun.file(capture).text()) as { pending: { origin?: string }; reason: string; ruleId: string };
  expect(given.ruleId).toBe("r1");
  // It sees the origin, not the path or query, because the record it is given is the redacted one.
  expect(given.pending.origin).toBe("https://example.test");
  expect(JSON.stringify(given)).not.toContain("/x");
});

test("the immune set matches a request's shape, not a page's description of it", () => {
  expect(immuneMatch("navigate", "https://bank.test/transfer", "POST")?.id).toBe("money-movement");
  expect(immuneMatch("navigate", "https://mail.test/account/password", "POST")?.id).toBe("credential-change");
  expect(immuneMatch("navigate", "https://id.test/oauth/authorize?response_type=code&client_id=x")?.id).toBe("oauth-grant");

  // Whole segments only, so a page cannot dodge the table by lengthening a word, and a word that
  // merely contains one cannot trip it either.
  expect(immuneMatch("navigate", "https://help.test/transfers-explained", "POST")).toBeNull();
  expect(immuneMatch("navigate", "https://help.test/how-to-transfer-money", "POST")).toBeNull();
  // The method matters where the entry names one: reading a settings page is not changing it.
  expect(immuneMatch("navigate", "https://mail.test/account/password", "GET")).toBeNull();
  // An oauth path without an authorisation response is documentation, not a grant.
  expect(immuneMatch("navigate", "https://id.test/oauth/authorize")).toBeNull();
  expect(immuneMatch("navigate", "not a url", "POST")).toBeNull();
  expect(immuneMatch("read", undefined)).toBeNull();
  // Every entry carries a stable id and a reason a person can read.
  for (const entry of immuneSet) {
    expect(entry.id).toMatch(/^[a-z-]+$/);
    expect(entry.reason.length).toBeGreaterThan(20);
  }
});

test("no autonomy level clears an immune id, and it is never sent to the advisor", () => {
  // Everything allowed, nothing denied, autonomous, with an advisor configured: the most permissive
  // policy the parser will produce.
  const permissive: SessionPolicy = {
    mode: "autonomous", origins: ["https://bank.test"], allow: ["read", "navigate", "write", "irreversible"],
    deny: [], advisor: { command: ["/bin/true"], timeoutMs: 1000 },
    rules: [{ id: "consult-everything", verb: ["navigate"], decision: "consult", reason: "second opinion" }],
  };
  const decision = decide(permissive, "navigate", "https://bank.test/transfer", "POST");
  expect(decision.outcome).toBe("deny");
  if (decision.outcome === "deny") {
    expect(decision.immuneId).toBe("money-movement");
    // Not a consult: a model judging a model is the wrong instrument for what nobody should do alone.
    expect(decision.reason).toContain("money");
  }
});

test("an immune deny contains the session, and containment cannot be undone", () => {
  let policy: SessionPolicy = {
    mode: "autonomous", origins: ["https://bank.test"], allow: ["read", "navigate", "write", "irreversible"], deny: [],
  };
  expect(decide(policy, "click").outcome).toBe("allow");
  // This is what the broker does on an immune deny: the agent that just tried it is either
  // compromised or wrong, and in both cases the next action should not run.
  policy = narrow(policy, { allow: ["read", "navigate"] });
  expect(decide(policy, "click").outcome).toBe("deny");
  expect(decide(policy, "read").outcome).toBe("allow");
  // Narrowing is one way: asking for it back returns nothing the policy no longer holds.
  policy = narrow(policy, { allow: ["read", "navigate", "write", "irreversible"] });
  expect(policy.allow).toEqual(["read", "navigate"]);
  expect(decide(policy, "click").outcome).toBe("deny");
});

test("rules lower a decision and can never raise one", () => {
  const base = { mode: "autonomous" as const, origins: ["https://example.test"], deny: ["irreversible" as const] };

  // A rule turns an allowed class into a deny for one origin and path.
  const narrowed: SessionPolicy = { ...base, allow: ["read", "navigate", "write"],
    rules: [{ id: "no-admin", verb: ["navigate"], origin: "https://example.test", pathPrefix: "/admin", decision: "deny" as const, reason: "admin is out of scope" }] };
  expect(decide(narrowed, "navigate", "https://example.test/admin/users").outcome).toBe("deny");
  expect(decide(narrowed, "navigate", "https://example.test/public").outcome).toBe("allow");
  // Whole segments: /administration is not /admin.
  expect(decide(narrowed, "navigate", "https://example.test/administration").outcome).toBe("allow");

  // A rule saying allow cannot lift a class that is denied, nor one that was never allowed.
  const cannotRaise: SessionPolicy = { ...base, allow: ["read"],
    rules: [{ id: "wishful", verb: ["click", "download"], decision: "allow" as const, reason: "please" }] };
  expect(decide(cannotRaise, "click").outcome).toBe("deny");
  expect(decide(cannotRaise, "download").outcome).toBe("deny");

  // Where several rules match, the strictest wins.
  const conflicting: SessionPolicy = { ...base, allow: ["read", "navigate"],
    advisor: { command: ["/bin/true"], timeoutMs: 1000 },
    rules: [
      { id: "soft", verb: ["navigate"], decision: "consult" as const, reason: "check it" },
      { id: "hard", verb: ["navigate"], pathPrefix: "/private", decision: "deny" as const, reason: "no" },
    ] };
  expect(decide(conflicting, "navigate", "https://example.test/private/x").outcome).toBe("deny");
  expect(decide(conflicting, "navigate", "https://example.test/open").outcome).toBe("consult");
});

test("a consult with no advisor refuses rather than quietly allowing", () => {
  const policy = parsePolicy({
    mode: "autonomous", origins: ["https://example.test"], allow: ["read", "navigate"],
    rules: [{ id: "check", verb: "navigate", decision: "consult", reason: "wanted a second opinion" }],
  });
  const decision = decide(policy, "navigate", "https://example.test/x");
  expect(decision.outcome).toBe("deny");
  // The rule singled this out for a second opinion; with nobody to give one, allowing it would be
  // the opposite of what the rule asked for.
  if (decision.outcome === "deny") expect(decision.reason).toContain("No advisor");
});

test("parsing refuses rules and advisors that would be decorative", () => {
  expect(() => parsePolicy({ rules: [{ verb: "click", decision: "deny" }] })).toThrow();
  expect(() => parsePolicy({ rules: [{ id: "x", decision: "deny" }] })).toThrow();
  expect(() => parsePolicy({ rules: [{ id: "x", verb: "click", decision: "maybe" }] })).toThrow();
  expect(() => parsePolicy({ rules: [{ id: "x", verb: "navigate", decision: "deny", origin: "*" }] })).toThrow();
  // An advisor has to be a real executable path, not a shell string the broker would have to split.
  expect(() => parsePolicy({ advisor: { command: "echo hi" } })).toThrow();
  expect(() => parsePolicy({ advisor: { command: ["echo"] } })).toThrow();
  expect(() => parsePolicy({ advisor: { command: [] } })).toThrow();
  expect(() => parsePolicy({ advisor: { command: ["/bin/true"], timeoutMs: 99 } })).toThrow();
  expect(() => parsePolicy({ advisor: { command: ["/bin/true"], timeoutMs: 60000 } })).toThrow();

  const parsed = parsePolicy({
    mode: "autonomous", origins: ["https://a.test"], allow: ["read", "navigate"],
    rules: [{ id: "r", verb: ["navigate", "click"], decision: "consult", reason: "look" }],
    advisor: { command: ["/bin/true"] },
  });
  expect(parsed.rules?.[0]?.id).toBe("r");
  expect(parsed.advisor?.timeoutMs).toBe(5000);
});
