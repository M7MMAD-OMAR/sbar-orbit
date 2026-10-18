import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { issueOwnedExperimentObserver, admitExperimentObserver } from "../experiments/owned-browser-observation";

test("observer bounds and copies the same single captured client length", async () => {
  const root = resolve("controlled-client-length-observation");
  const identity = Object.freeze({ root, profiles: Object.freeze([join(root, "a"), join(root, "b")]),
    contexts: Object.freeze([{}, {}]), backends: Object.freeze([{}, {}]) });
  let lengthReads = 0;
  const clients = new Proxy(Array(257).fill(1), {
    get(target, key, receiver) {
      if (key === "length") return ++lengthReads === 1 ? 1 : 257;
      return Reflect.get(target, key, receiver);
    },
  });
  const observer = admitExperimentObserver(identity, scope => issueOwnedExperimentObserver(scope, {}, () => true,
    async () => ({ activePid: 0, clientPids: clients })));
  try {
    const result = await observer.read();
    expect(result.clientPids.length).toBeLessThanOrEqual(256);
    expect(result.clientPids).toEqual([1]);
    expect(lengthReads).toBe(1);
  } finally { observer.close(); }
});
