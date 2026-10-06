import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ChromeTransportObserver, currentChromeTransportObservation, forwardChromeProtocol, forwardChromeSend, forwardChromeReceive, forwardChromeEvent } from "../src/chrome-transport-observer";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const producer = { chrome: "a".repeat(64), observer: "b".repeat(64), fixture: "c".repeat(64), lock: "d".repeat(64), coreBundle: "e".repeat(64), dependencyVersion: "1.63.0" };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function rows(values: unknown[]) {
  return values.flatMap(value => object(value) && object(value.record) ? [value.record] : []);
}
async function owned<T>(operation: (root: string, profile: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "orbit-protocol-control-"));
  try {
    const profile = join(root, "profile-control");
    await mkdir(profile, { mode: 0o700 });
    return await operation(root, profile);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("protocol observer preserves receivers arguments and returned promise identity", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  await observer.scope(root, async () => {
    const connection = currentChromeTransportObservation(profile), receiver = { tag: "owned" };
    expect(connection).toBeDefined();
    const message = { id: 1, method: "Fetch.continueRequest", params: { requestId: "owned-interception" } };
    const result = Promise.resolve("original-result");
    let calls = 0;
    const returned = forwardChromeProtocol(connection, "receive", receiver, function (arg: typeof message) {
      expect(this).toBe(receiver); expect(arg).toBe(message); calls++; return result;
    }, [message], message);
    expect(returned).toBe(result); expect(calls).toBe(1); await result;
  });
  observer.finish();
}));

test("protocol adapters stringify and parse once before exact original forwarding", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile), receiver = { tag: "socket" };
    let strings = 0, conversions = 0, sends = 0, receives = 0;
    const message = { id: 4, method: "Fetch.failRequest", toJSON() { strings++; return { id: 4, method: "Fetch.failRequest" }; } };
    const sent = forwardChromeSend(connection, receiver, function (wire) {
      expect(this).toBe(receiver); expect(wire).toBe('{"id":4,"method":"Fetch.failRequest"}');
      expect(rows(values).at(-1)?.stage).toBe("before"); sends++; return receiver;
    }, message);
    expect(sent).toBe(receiver);
    const received = forwardChromeReceive(connection, receiver, function (value: unknown) {
      expect(this).toBe(receiver); expect(value).toEqual({ id: 4, result: {} });
      expect(rows(values).at(-1)?.stage).toBe("before"); receives++; return receiver;
    }, { toString() { conversions++; return '{"id":4,"result":{}}'; } });
    expect(received).toBe(receiver);
    expect([strings, conversions, sends, receives]).toEqual([1, 1, 1, 1]);
  });
  observer.finish();
}));

test("protocol observer preserves serialization parsing and synchronous throw objects", async () => owned(async (root, profile) => {
  const observer = new ChromeTransportObserver(producer, () => { throw new Error("sink failure"); });
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile), thrown = new Error("original throw"), receiver = {};
    let calls = 0;
    let observed: unknown;
    try { forwardChromeProtocol(connection, "receive", receiver, function () { calls++; throw thrown; }, [], {}); }
    catch (error) { observed = error; }
    expect(observed).toBe(thrown); expect(calls).toBe(1); observed = undefined;
    try { forwardChromeSend(connection, receiver, () => { calls++; }, { toJSON() { throw thrown; } }); }
    catch (error) { observed = error; }
    expect(observed).toBe(thrown); observed = undefined;
    try { forwardChromeReceive(connection, receiver, () => { calls++; }, { toString() { throw thrown; } }); }
    catch (error) { observed = error; }
    expect(observed).toBe(thrown); expect(calls).toBe(1);
  });
  observer.finish(); observer.finish();
}));

test("protocol duplicate response history is distinct from no observed send", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile);
    connection?.before("send", { id: 3, sessionId: "one", method: "Fetch.fulfillRequest" });
    connection?.after("send", "returned", { id: 3, sessionId: "one" });
    connection?.before("receive", { id: 3, sessionId: "one", result: {} });
    connection?.before("receive", { id: 3, sessionId: "one", error: { code: -32602, message: "Invalid InterceptionId." } });
    const duplicate = rows(values).at(-1);
    expect(duplicate?.observedSend).toBe(true); expect(duplicate?.duplicateResponse).toBe(true);
    expect(duplicate?.observedSendOutcome).toBe("returned"); expect(duplicate?.errorCategory).toBe("InvalidInterceptionId");
    connection?.before("receive", { id: 99, sessionId: "one", error: { code: -32602, message: "Invalid InterceptionId." } });
    expect(rows(values).at(-1)?.observedSend).toBe(false); expect(rows(values).at(-1)?.duplicateResponse).toBe(false);
  });
  observer.finish();
}));

test("protocol session connection and crash detach ordering stay distinct", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const first = currentChromeTransportObservation(profile), second = currentChromeTransportObservation(profile);
    first?.before("send", { id: 7, sessionId: "first", method: "Fetch.continueRequest" });
    first?.before("receive", { method: "Inspector.targetCrashed", sessionId: "first" });
    first?.before("receive", { method: "Target.detachedFromTarget", params: { sessionId: "first", targetId: "owned" } });
    first?.before("receive", { id: 7, sessionId: "other", error: { code: -32602, message: "Invalid InterceptionId." } });
    const mismatch = rows(values).at(-1);
    expect(mismatch?.observedSend).toBe(false); expect(mismatch?.otherSessionSameId).toBe(true);
    second?.before("receive", { id: 7, sessionId: "first", result: {} });
    expect(rows(values).at(-1)?.observedSend).toBe(false); expect(rows(values).at(-1)?.otherSessionSameId).toBe(false);
    const seen = rows(values); expect(seen.findIndex(row => row.category === "Inspector.targetCrashed")).toBeLessThan(seen.findIndex(row => row.errorCategory === "InvalidInterceptionId"));
    const detach = seen.find(row => row.category === "Target.detachedFromTarget");
    const request = seen.find(row => row.category === "Fetch.continueRequest");
    expect(detach?.childSession).toBe(request?.session); expect(detach?.session).toBeNull();
  });
  observer.finish();
}));

test("protocol observer excludes private payloads and arbitrary categories", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile), secret = "fixture-private-canary";
    connection?.before("send", { id: 5, method: secret, sessionId: secret, params: { url: secret, headers: { cookie: secret }, body: secret } });
    connection?.before("receive", { id: 5, sessionId: secret, error: { code: -32602, message: secret }, result: { title: secret } });
    expect(rows(values).at(-1)?.category).toBe("other"); expect(rows(values).at(-1)?.errorCategory).toBe("other-error");
    observer.finish(); expect(JSON.stringify(values)).not.toContain(secret); expect(JSON.stringify(values)).not.toContain(root);
  });
}));

test("protocol observation is dormant refuses foreign profiles and admits canonical owned aliases", async () => owned(async (root, profile) => {
  expect(currentChromeTransportObservation(profile)).toBeUndefined();
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  const foreign = join(root, "foreign"); await mkdir(foreign, { mode: 0o700 });
  observer.scope(root, () => {
    expect(currentChromeTransportObservation(foreign)).toBeUndefined();
    expect(currentChromeTransportObservation(join(root, "missing", "profile-other"))).toBeUndefined();
    expect(currentChromeTransportObservation(profile)).toBeDefined();
  });
  const alias = join(root, "alias"); await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  observer.scope(alias, () => expect(currentChromeTransportObservation(join(alias, "profile-control"))).toBeDefined());
  observer.finish(); expect(JSON.stringify(values)).not.toContain(root);
}));

test("protocol observer finish prevents held late registration and repeated finish writes", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = observer.scope(root, async () => {
    const connection = currentChromeTransportObservation(profile); await held;
    connection?.before("receive", { id: 6 });
    expect(currentChromeTransportObservation(profile)).toBeUndefined();
  });
  observer.finish(); const writes = values.length; release(); await work; observer.finish();
  expect(values.length).toBe(writes);
}));

test("protocol observer bounds maps records and incomplete correlation", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile);
    for (let id = 0; id < 900; id++) connection?.before("send", { id, method: "Fetch.failRequest" });
    connection?.before("receive", { id: 0, error: { code: -32602, message: "Invalid InterceptionId." } });
    expect(rows(values).at(-1)?.mapComplete).toBe(false); expect(rows(values).at(-1)?.observedSend).toBe(false);
    observer.finish();
    const last = values.at(-1);
    expect(object(last) && object(last.final) && Array.isArray(last.final.first) ? last.final.first.length : -1).toBe(64);
    expect(object(last) && object(last.final) && Array.isArray(last.final.recent) ? last.final.recent.length : -1).toBe(192);
    expect(values.length).toBeLessThanOrEqual(81);
  });
}));

test("protocol observer getter and sink failures leave original forwarding unchanged", async () => owned(async (root, profile) => {
  const observer = new ChromeTransportObserver(producer, () => { throw new Error("sink"); });
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile), receiver = {}, message = { get id() { throw new Error("getter"); } };
    let calls = 0;
    expect(forwardChromeProtocol(connection, "receive", receiver, function (arg: unknown) { expect(this).toBe(receiver); expect(arg).toBe(message); calls++; return receiver; }, [message], message)).toBe(receiver);
    expect(calls).toBe(1); observer.finish();
  });
}));

test("protocol observer marks unknown session identity as incomplete rather than root", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile);
    connection?.before("send", { id: 1, method: "Fetch.failRequest" });
    connection?.before("receive", { id: 1, sessionId: "x".repeat(8193), result: {} });
    const last = rows(values).at(-1);
    expect(last?.sessionKnown).toBe(false); expect(last?.mapComplete).toBe(false);
    expect(last?.observedSend).toBeUndefined();
  });
  observer.finish();
}));

test("protocol observer concurrent async scopes do not share connection state", async () => owned(async (root, profile) => {
  const firstValues: unknown[] = [], secondValues: unknown[] = [];
  const first = new ChromeTransportObserver(producer, value => firstValues.push(value));
  const second = new ChromeTransportObserver(producer, value => secondValues.push(value));
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = first.scope(root, async () => {
    await held;
    currentChromeTransportObservation(profile)?.before("receive", { id: 2 });
  });
  await second.scope(root, async () => {
    await Promise.resolve();
    currentChromeTransportObservation(profile)?.before("send", { id: 2, method: "Fetch.failRequest" });
  });
  release(); await work;
  expect(rows(firstValues).at(-1)?.observedSend).toBe(false);
  expect(rows(secondValues).at(-1)?.direction).toBe("send");
  expect(currentChromeTransportObservation(profile)).toBeUndefined();
  first.finish(); second.finish();
}));

test("protocol callback asynchronous rejection remains an unhandled child failure", async () => {
  const child = Bun.spawn([process.execPath, "run", fileURLToPath(new URL("./chrome-transport-observer-rejection-probe.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0); expect(stdout + stderr).toContain("owned-protocol-original-rejection");
});

test("protocol fixture phases retain setup throw and unconfirmed cleanup", () => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  const original = new Error("owned setup failure");
  let caught: unknown;
  try { observer.observe("fixture-start", () => { throw original; }); }
  catch (error) { caught = error; }
  observer.finish(); expect(caught).toBe(original);
  const last = values.at(-1), boundaries = object(last) && object(last.final) ? last.final.boundaries : undefined;
  expect(boundaries).toContainEqual({ phase: "fixture-start", state: "threw" });
  expect(boundaries).toContainEqual({ phase: "broker-close", state: "not entered" });
  expect(boundaries).toContainEqual({ phase: "fixture-stop", state: "not entered" });
});

test("protocol absent callback never reads data converts String or parses JSON", () => {
  const receiver = {};
  let dataReads = 0, conversions = 0;
  expect(forwardChromeEvent(undefined, receiver, { get data() { dataReads++; throw new Error("owned-absent-callback-data-getter"); } })).toBeUndefined();
  expect(forwardChromeEvent(undefined, receiver, { get data() { dataReads++; return { toString() { conversions++; throw new Error("owned-absent-callback-string"); } }; } })).toBeUndefined();
  expect(forwardChromeEvent(undefined, receiver, { get data() { dataReads++; return "invalid-json"; } })).toBeUndefined();
  expect([dataReads, conversions]).toEqual([0, 0]);
});

test("protocol receive reads callback once before data getter conversion and forwarding", () => {
  const order: string[] = [], result = Promise.resolve("owned-original-result");
  const receiver = { get onmessage() {
    order.push("callback");
    return function (this: unknown, message: unknown) { expect(this).toBe(receiver); expect(message).toEqual({ id: 1 }); order.push("forward"); return result; };
  } };
  const actual = forwardChromeEvent(undefined, receiver, { get data() {
    order.push("data"); return { toString() { order.push("String"); return '{"id":1}'; } };
  } });
  expect(actual).toBe(result); expect(order).toEqual(["callback", "data", "String", "forward"]);
  const original = new Error("owned-callback-getter"), throwing = { get onmessage(): undefined { throw original; } };
  let caught: unknown;
  try { forwardChromeEvent(undefined, throwing, { get data() { order.push("unreachable-data"); return "invalid-json"; } }); }
  catch (error) { caught = error; }
  expect(caught).toBe(original); expect(order).not.toContain("unreachable-data");
});

test("protocol invocation never reads a callable own call property", () => {
  const receiver = {}, result = Promise.resolve("owned-result");
  let calls = 0, propertyReads = 0;
  const callback = function (this: unknown, message: unknown) { expect(this).toBe(receiver); expect(message).toEqual({ id: 8 }); calls++; return result; };
  Object.defineProperty(callback, "call", { get() { propertyReads++; throw new Error("owned-call-property-getter"); } });
  expect(forwardChromeProtocol(undefined, "receive", receiver, callback, [{ id: 8 }], { id: 8 })).toBe(result);
  expect([calls, propertyReads]).toEqual([1, 0]);
});

test("fixture unawaited stop rejection preserves baseline child failure", async () => {
  for (const mode of ["fixture-baseline", "fixture-observed"]) {
    const child = Bun.spawn([process.execPath, "run", fileURLToPath(new URL("./chrome-transport-observer-rejection-probe.ts", import.meta.url)), mode], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("owned-fixture-stop-original-rejection");
  }
});

test("fixture observation preserves original promise identity without handlers", () => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  const original = new Promise<void>(() => {});
  Object.defineProperty(original, "then", { get() { throw new Error("owned-original-then-getter"); } });
  expect(observer.observe("fixture-stop", () => original)).toBe(original);
  observer.finish();
  const final = values.at(-1);
  expect(object(final) && object(final.final) ? final.final.pending : undefined).toEqual(["fixture-stop"]);
});

test("fixture settled acknowledgment follows an existing await and stays inert after finish", async () => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  await observer.observe("open-broker", () => Promise.resolve());
  observer.settled("open-broker");
  observer.finish(); const count = values.length;
  observer.settled("fixture-stop"); observer.finish(); expect(values.length).toBe(count);
  const final = values.at(-1);
  expect(object(final) && object(final.final) ? final.final.boundaries : undefined).toContainEqual({ phase: "open-broker", state: "settled" });
});


function finalOf(values: unknown[]) {
  const value = values.at(-1);
  return object(value) && object(value.final) ? value.final : undefined;
}

test.each([false, true])("browser version final is explicitly unknown without response, earlyThrow=%s", earlyThrow => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  if (earlyThrow) {
    const original = new Error("owned early setup error"); let caught: unknown;
    try { observer.observe("open-broker", () => { throw original; }); } catch (error) { caught = error; }
    expect(caught).toBe(original);
  }
  observer.finish(); expect(finalOf(values)?.browserVersion).toBe("not measured");
  expect(finalOf(values)?.browserVersionSource).toBe("not measured");
});

test("browser version final retains matched existing reply provenance", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile);
    connection?.before("send", { id: 1, method: "Browser.getVersion" });
    connection?.after("send", "returned", { id: 1 });
    connection?.before("receive", { id: 1, result: { product: "Chrome/154.0.8037.98" } });
    connection?.before("receive", { id: 1, result: { product: "Chrome/154.0.8037.98" } });
  });
  observer.finish(); expect(finalOf(values)?.browserVersion).toBe("Chrome/154.0.8037.98");
  expect(finalOf(values)?.browserVersions).toEqual([{ connection: 1, browserVersion: "Chrome/154.0.8037.98", state: "matched existing response", requestId: 1, session: null }]);
}));

test("browser version ignores unmatched replies and rejects malformed failed sends", async () => owned(async (root, profile) => {
  for (const mode of ["unmatched", "malformed", "send-threw", "error-response", "unknown-session"]) {
    const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
    observer.scope(root, () => {
      const connection = currentChromeTransportObservation(profile);
      if (mode !== "unmatched") {
        connection?.before("send", { id: 1, method: "Browser.getVersion" });
        connection?.after("send", mode === "send-threw" ? "threw" : "returned", { id: 1 });
      }
      connection?.before("receive", { id: 1, ...(mode === "unknown-session" ? { sessionId: "foreign" } : {}),
        ...(mode === "error-response" ? { error: { code: -32000, message: "owned response error" } } : {}),
        result: { product: mode === "malformed" ? "owned-private-version-canary" : "Chrome/154.0.8037.98" } });
    });
    observer.finish(); expect(finalOf(values)?.browserVersion).toBe("not measured");
    expect(JSON.stringify(values)).not.toContain("owned-private-version-canary");
  }
}));

test("browser version conflicting matched replies remain explicitly unknown", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const connection = currentChromeTransportObservation(profile);
    for (const [id, version] of [[1, "Chrome/154.0.8037.98"], [2, "Chrome/154.0.8037.99"], [3, "Chrome/154.0.8037.98"]] as const) {
      connection?.before("send", { id, method: "Browser.getVersion" }); connection?.after("send", "returned", { id });
      connection?.before("receive", { id, result: { product: version } });
    }
  });
  observer.finish(); expect(finalOf(values)?.browserVersion).toBe("not measured");
  expect(finalOf(values)?.browserVersions).toEqual([{ connection: 1, browserVersion: "not measured", state: "conflicting matched responses", requestId: null, session: null }]);
}));

test("browser version aggregate preserves unknown separate connection evidence", async () => owned(async (root, profile) => {
  const values: unknown[] = [], observer = new ChromeTransportObserver(producer, value => values.push(value));
  observer.scope(root, () => {
    const first = currentChromeTransportObservation(profile); currentChromeTransportObservation(profile);
    first?.before("send", { id: 1, method: "Browser.getVersion" }); first?.after("send", "returned", { id: 1 });
    first?.before("receive", { id: 1, result: { product: "Chrome/154.0.8037.98" } });
  });
  observer.finish(); expect(finalOf(values)?.browserVersion).toBe("not measured");
  expect(finalOf(values)?.browserVersions).toContainEqual({ connection: 2, browserVersion: "not measured", state: "not observed", requestId: null, session: null });
}));
