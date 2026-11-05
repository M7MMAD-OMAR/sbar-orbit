import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Diagnostics } from "../src/diagnostics";
import { OrbitError } from "../src/errors";
import { errorPayload } from "../src/error-disposition";
import { decide, journalEntry, parseActionClasses, parseOrigins, parsePolicy } from "../src/policy";

const secret = "PRIVATE_POLICY_INPUT_9f42";
const badOrigin = "https://" + secret + " bad.invalid/private?token=" + secret;
const advisor = process.platform === "win32" ? "C:\\owned-fixture\\advisor.exe" : "/owned-fixture/advisor";
function refused(work: () => unknown): OrbitError {
  let caught: unknown;
  try { work(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(OrbitError);
  expect(caught).toMatchObject({ code: "INVALID_REQUEST" });
  return caught as OrbitError;
}
function noSecret(error: OrbitError) {
  // Exercise the public payload and the same content fields a debug CLI includes,
  // without changing ORBIT_DEBUG or any process-global environment/logging hooks.
  const debug = { ...errorPayload(error, "INVALID_REQUEST", "Policy request refused"), stack: error.stack?.split("\n").slice(0, 8) };
  expect(error.message).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(JSON.stringify(debug)).not.toContain(secret);
}
const inputCases: (() => unknown)[] = [
  () => parseOrigins([badOrigin]),
  () => parsePolicy({ origins: [badOrigin] }),
  () => parsePolicy({ rules: [{ id: "fixed-rule", verb: "click", decision: "deny", origin: badOrigin }] }),
  () => parseActionClasses([secret], "allow"),
  () => parseActionClasses([secret], "deny"),
  () => parseActionClasses(null, secret),
  () => parsePolicy({ allow: [secret] }),
  () => parsePolicy({ deny: [secret] }),
  () => parsePolicy({ rules: [{ id: secret, verb: "click", decision: "invalid" }] }),
  () => parsePolicy({ rules: [{ id: secret, verb: 42, decision: "deny" }] }),
];

async function fixture() {
  const prefix = "orbit-policy-redaction-", created = await mkdtemp(join(tmpdir(), prefix));
  const root = await realpath(created), parent = await realpath(dirname(created));
  const diagnostics = new Diagnostics(join(root, "diagnostics"));
  return { root, diagnostics, close: async () => {
    await diagnostics.flush();
    const info = await lstat(root);
    if (dirname(root) !== parent || !basename(root).startsWith(prefix) || !info.isDirectory()
        || info.isSymbolicLink() || await realpath(root) !== root)
      throw new Error("Refusing cleanup outside the exact owned policy fixture");
    await rm(root, { recursive: true, force: true });
  } };
}

test("invalid policy origins classes and rule identifiers never enter validation errors", () => {
  for (const work of inputCases) noSecret(refused(work));
  expect(refused(() => parseActionClasses(null, "allow")).message).toContain("allow");
  expect(refused(() => parseActionClasses(null, "deny")).message).toContain("deny");
});

test("public action class field labels and unknown entries never coerce untrusted objects", () => {
  let calls = 0;
  const hostile = { [Symbol.toPrimitive]() { calls++; throw new Error(secret); },
    toString() { calls++; return secret; } };
  noSecret(refused(() => parseActionClasses(null, hostile as never)));
  noSecret(refused(() => parseActionClasses([secret], hostile as never)));
  noSecret(refused(() => parseActionClasses([hostile], hostile as never)));
  noSecret(refused(() => parseActionClasses([hostile], "allow")));
  noSecret(refused(() => parsePolicy({ deny: [hostile] })));
  noSecret(refused(() => parseOrigins([hostile])));
  noSecret(refused(() => parseActionClasses(null, Symbol(secret) as never)));
  expect(calls).toBe(0);
});

function throwingCases(makeError: () => Error, count: () => void): (() => unknown)[] {
  const hostile = { [Symbol.toPrimitive]() { count(); throw makeError(); } };
  return [
    () => parsePolicy({ mode: hostile }),
    () => parsePolicy({ rules: [{ id: "fixed-rule", verb: "click", decision: hostile }] }),
    () => parsePolicy({ rules: [{ id: "fixed-rule", verb: "click", decision: "deny", pathPrefix: hostile }] }),
    () => parsePolicy({ rules: [{ id: "fixed-rule", verb: "click", decision: "deny", method: hostile }] }),
    () => parsePolicy({ advisor: { command: [advisor], timeoutMs: hostile } }),
  ];
}

test("existing policy coercion failures redact raw and forged OrbitError messages", () => {
  for (const makeError of [() => new Error(secret), () => new OrbitError("INVALID_REQUEST", secret)]) {
    let calls = 0;
    const cases = throwingCases(makeError, () => { calls++; });
    for (const work of cases) noSecret(refused(work));
    expect(calls).toBe(cases.length);
  }
});

test("real diagnostics journal report and issue URL exclude rejected policy content", async () => {
  const state = await fixture();
  try {
    const policies = [
      { origins: [badOrigin] }, { allow: [secret] }, { deny: [secret] },
      { rules: [{ id: secret, verb: "click", decision: "invalid" }] },
      { rules: [{ id: secret, verb: 42, decision: "deny" }] },
      { rules: [{ id: "fixed-rule", verb: "click", decision: "deny", origin: badOrigin }] },
    ];
    for (const policy of policies) {
      const request = JSON.parse(JSON.stringify({ method: "session.create", params: { policy } })) as {
        method: string; params: { policy: unknown };
      };
      let caught: unknown;
      try { await state.diagnostics.run(request, async () => parsePolicy(request.params.policy)); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OrbitError);
      noSecret(caught as OrbitError);
    }
    await state.diagnostics.flush();
    const report = await state.diagnostics.report();
    expect(report.events.filter(event => event.outcome === "error")).toHaveLength(policies.length);
    for (const event of report.events.filter(event => event.outcome === "error")) {
      expect(event.code).toBe("INVALID_REQUEST");
      expect(event.detail).toBeTruthy();
    }
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(decodeURIComponent(report.issueUrl)).not.toContain(secret);
    expect(await readFile(join(state.root, "diagnostics", "events.jsonl"), "utf8")).not.toContain(secret);
  } finally { await state.close(); }
});

test("coercion failures stay classified and secret-free through actual diagnostic wrapping", async () => {
  const state = await fixture();
  try {
    let calls = 0;
    const cases = throwingCases(() => new Error(secret), () => { calls++; });
    for (const work of cases) {
      let caught: unknown;
      try { await state.diagnostics.run({ method: "session.create", params: {} }, async () => work()); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OrbitError);
      noSecret(caught as OrbitError);
    }
    expect(calls).toBe(cases.length);
    const report = await state.diagnostics.report();
    expect(report.events.filter(event => event.outcome === "error").map(event => event.code)).toEqual(cases.map(() => "INVALID_REQUEST"));
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(decodeURIComponent(report.issueUrl)).not.toContain(secret);
    expect(await readFile(join(state.root, "diagnostics", "events.jsonl"), "utf8")).not.toContain(secret);
  } finally { await state.close(); }
});

test("successful origins classes and legacy textual/numeric coercions retain their behavior", () => {
  expect(parseOrigins(["EXAMPLE.test/path", "https://example.test/other"])).toEqual(["https://example.test"]);
  expect(parseActionClasses(["read", "write", "read"], "allow")).toEqual(["read", "write", "read"]);
  const policy = parsePolicy({ mode: { toString: () => "autonomous" }, origins: "any", allow: ["read", "write"],
    rules: [{ id: "kept-rule", verb: "click", decision: "deny", pathPrefix: { toString: () => "/kept" }, method: { toString: () => "POST" } }],
    advisor: { command: [advisor], timeoutMs: { valueOf: () => 500 } } });
  expect(policy.mode).toBe("autonomous");
  expect(policy.rules?.[0]).toMatchObject({ id: "kept-rule", pathPrefix: "/kept", method: "POST", reason: "Rule kept-rule." });
  expect(policy.advisor?.timeoutMs).toBe(500);
});

test("valid rule IDs and successful default reasons remain deliberate journal content", () => {
  const policy = parsePolicy({ mode: "autonomous", origins: "any", allow: ["read", "write"],
    rules: [{ id: secret, verb: "click", decision: "deny" }] });
  expect(policy.rules?.[0]).toMatchObject({ id: secret, reason: "Rule " + secret + "." });
  const decision = decide(policy, "click", "https://example.test/kept");
  expect(decision).toMatchObject({ outcome: "deny", ruleId: secret });
  expect(journalEntry({ sequence: 1, sessionId: "owned", actor: "agent", actionType: "click", decision })).toMatchObject({ ruleId: secret });
  // Validation-error redaction is not a claim that valid owner policy reasons,
  // rule IDs or policy-denial journals are content-free. That contract is unchanged.
});


test("JSON null coercion methods in every legacy conversion yield exact fixed policy errors", async () => {
  const state = await fixture();
  const hostile = { toString: null, valueOf: null, private: secret };
  const cases = [
    [{ mode: hostile }, "Policy mode must be supervised or autonomous"],
    [{ rules: [{ id: "fixed-rule", verb: "click", decision: hostile }] }, "Policy rule needs a decision of allow, deny or consult"],
    [{ rules: [{ id: "fixed-rule", verb: "click", decision: "deny", pathPrefix: hostile }] }, "Policy rule pathPrefix must be usable as text"],
    [{ rules: [{ id: "fixed-rule", verb: "click", decision: "deny", method: hostile }] }, "Policy rule method must be usable as text"],
    [{ advisor: { command: [advisor], timeoutMs: hostile } }, "An advisor timeout must be between 100 and 30000 ms"],
  ] as const;
  try {
    for (const [policy, message] of cases) {
      const request = JSON.parse(JSON.stringify({ method: "session.create", params: { policy } })) as {
        method: string; params: { policy: unknown };
      };
      const direct = refused(() => parsePolicy(request.params.policy));
      expect(direct.message).toBe(message);
      noSecret(direct);
      let caught: unknown;
      try { await state.diagnostics.run(request, async () => parsePolicy(request.params.policy)); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OrbitError);
      expect(caught).toMatchObject({ code: "INVALID_REQUEST", message });
      noSecret(caught as OrbitError);
    }
    const report = await state.diagnostics.report();
    expect(report.events.filter(event => event.outcome === "error").map(event => event.code)).toEqual(cases.map(() => "INVALID_REQUEST"));
    expect(report.events.filter(event => event.outcome === "error").map(event => event.detail)).toEqual(cases.map(([, message]) => message));
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(decodeURIComponent(report.issueUrl)).not.toContain(secret);
    const events = await readFile(join(state.root, "diagnostics", "events.jsonl"), "utf8");
    expect(events).not.toContain(secret);
    expect(events).not.toContain("Cannot convert object");
  } finally { await state.close(); }
});

test("JSON null coercion field labels use a fixed generic name for nonarray and unknown entries", () => {
  const value = JSON.parse(JSON.stringify({ toString: null, valueOf: null, private: secret })) as unknown;
  const missing = refused(() => parseActionClasses(null, value as never));
  expect(missing.message).toBe("Policy action classes must be an array of action classes");
  noSecret(missing);
  for (const entries of [[secret], [value]]) {
    const unknown = refused(() => parseActionClasses(entries, value as never));
    expect(unknown.message).toBe("Unknown action class in policy action classes");
    noSecret(unknown);
  }
  expect(parseActionClasses(["read"], value as never)).toEqual(["read"]);
});
