import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { issueOwnedExperimentObserver, admitExperimentObserver } from "../experiments/owned-browser-observation";

test("sparse client PID arrays cannot be admitted as numeric observations", async () => {
  const root = resolve("controlled-sparse-observation");
  const identity = Object.freeze({ root, profiles: Object.freeze([join(root, "a"), join(root, "b")]),
    contexts: Object.freeze([{}, {}]), backends: Object.freeze([{}, {}]) });
  const observer = admitExperimentObserver(identity, scope => issueOwnedExperimentObserver(scope, {}, () => true,
    async () => ({ activePid: 0, clientPids: new Array(1) })));
  try { await expect(observer.read()).rejects.toThrow("Owned experiment observer unavailable"); }
  finally { observer.close(); }
});
