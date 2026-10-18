import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { admitExperimentObserver, issueOwnedExperimentObserver } from "../experiments/owned-browser-observation";

const identity = () => {
  const root = resolve("controlled-owned-experiment");
  return Object.freeze({ root, profiles: Object.freeze([join(root, "a"), join(root, "b")]),
    contexts: Object.freeze([{}, {}]), backends: Object.freeze([{}, {}]) });
};
test("unissued observer cannot query even with ambient compositor variables", () => {
  let reads = 0;
  expect(() => admitExperimentObserver(identity(), () => ({ read: () => { reads++; } }))).toThrow("admission refused");
  expect(reads).toBe(0);
});
test("observer belongs to the exact original backend context workspace and profile identity", () => {
  const original = identity();
  const token = issueOwnedExperimentObserver(original, {}, () => true, async () => ({ activePid: 0, clientPids: [] }));
  expect(() => admitExperimentObserver(identity(), () => token)).toThrow("admission refused");
  expect(() => admitExperimentObserver(Object.freeze({ ...original }), () => token)).toThrow("admission refused");
});
test("owned observation detaches numeric fields and discards private content", async () => {
  const owner = identity();
  const value = { activePid: 12, clientPids: [14], title: "private-action-text", url: "credential" };
  const observer = admitExperimentObserver(owner, scope => issueOwnedExperimentObserver(scope, {}, () => true, async () => value));
  const sample = await observer.read(); value.clientPids.push(15);
  expect(sample).toEqual({ activePid: 12, clientPids: [14] });
  expect(JSON.stringify(sample)).not.toContain("private-action-text");
  expect(Object.isFrozen(sample.clientPids)).toBe(true);
  observer.close();
});
test("revoked lease prevents later transport calls", async () => {
  const owner = identity(); let calls = 0;
  const observer = admitExperimentObserver(owner, scope => issueOwnedExperimentObserver(scope, {}, () => true, async () => { calls++; return { activePid: 0, clientPids: [] }; }));
  observer.close(); await expect(observer.read()).rejects.toThrow("unavailable"); expect(calls).toBe(0);
});
test("closed observer refuses settlement from an already pending transport", async () => {
  const owner = identity(); let settle: (value: unknown) => void = () => {};
  const observer = admitExperimentObserver(owner, scope => issueOwnedExperimentObserver(scope, {}, () => true,
    () => new Promise(resolve => { settle = resolve; })));
  const pending = observer.read(); observer.close(); settle({ activePid: 0, clientPids: [] });
  await expect(pending).rejects.toThrow("unavailable");
});
test("dead compositor and concurrent reads fail closed", async () => {
  const owner = identity(); let live = true; let settle: (value: unknown) => void = () => {};
  const observer = admitExperimentObserver(owner, scope => issueOwnedExperimentObserver(scope, {}, () => live,
    () => new Promise(resolve => { settle = resolve; })));
  const first = observer.read(); await expect(observer.read()).rejects.toThrow("unavailable");
  live = false; settle({ activePid: 0, clientPids: [] }); await expect(first).rejects.toThrow("unavailable");
  observer.close();
});
test("oversized or invalid private observations fail without leaking transport errors", async () => {
  for (const value of [{ activePid: -1, clientPids: [] }, { activePid: 0, clientPids: Array(257).fill(1) }, { activePid: 0, clientPids: ["private"] }]) {
    const observer = admitExperimentObserver(identity(), scope => issueOwnedExperimentObserver(scope, {}, () => true, async () => value));
    await expect(observer.read()).rejects.toThrow("unavailable"); observer.close();
  }
  const observer = admitExperimentObserver(identity(), scope => issueOwnedExperimentObserver(scope, {}, () => true, async () => { throw new Error("private credential"); }));
  await expect(observer.read()).rejects.toThrow("Owned experiment observer unavailable"); observer.close();
});
test("unsettled private transport is bounded and its lease revoked", async () => {
  let signal: AbortSignal | undefined;
  const observer = admitExperimentObserver(identity(), scope => issueOwnedExperimentObserver(scope, {}, () => true,
    value => { signal = value; return new Promise(() => {}); }));
  await expect(observer.read()).rejects.toThrow("unavailable");
  expect(signal?.aborted).toBe(true);
  await expect(observer.read()).rejects.toThrow("unavailable");
}, 3000);
