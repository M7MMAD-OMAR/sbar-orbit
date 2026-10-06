import { expect, test } from "bun:test";
import { assertSameIdentity } from "./windows-census-fixture";
import { captureProcessWitnesses, WitnessCaptureError, type WitnessApi } from "./windows-process-witness";

function fixture() {
  let live = true;
  const held = new Set<number>(), closed: number[] = [];
  const api: WitnessApi = {
    open(pid) { if (pid !== 42 || !live) throw new Error("OpenProcess owned PID 42 failed, error 87"); held.add(1042); return 1042; },
    identity(handle) { if (!held.has(handle)) throw new Error("Identity is unknown"); return { creationTicks: "104200", image: "bun.exe" }; },
    state(handle) { if (!held.has(handle)) throw new Error("State is unknown"); return { state: live ? "alive" : "exited", exitCode: live ? 259 : 0, exitTicks: live ? "0" : "104300" }; },
    close(handle) { closed.push(handle); held.delete(handle); },
  };
  return { api, closed, exit() { live = false; } };
}

test("portable deferred acquisition remains unknown after census child exit", () => {
  const box = fixture(); box.exit();
  expect(() => captureProcessWitnesses([42], box.api)).toThrow("error 87");
  expect(box.closed).toEqual([]);
});

test("portable retained capture preserves the same identity after census completion", () => {
  const box = fixture(), handle = box.api.open(42), before = box.api.identity(handle);
  box.exit();
  const witnesses = captureProcessWitnesses([42], { ...box.api, open(pid) { if (pid !== 42) throw new Error("Unowned process"); return handle; } });
  const [measured] = witnesses.observe();
  if (!measured) throw new Error("Owned identity is absent");
  assertSameIdentity(measured, before);
  expect(measured).toMatchObject({ pid: 42, state: "exited", exitTicks: "104300" });
  expect(() => assertSameIdentity({ ...measured, creationTicks: "other" }, before)).toThrow("changed");
  witnesses.close();
  expect(box.closed).toEqual([handle]);
});

test("portable partial capture preserves failed close ownership for retry", () => {
  const box = fixture();
  box.api.identity = () => { throw new Error("Identity unknown"); };
  box.api.close = () => { throw new Error("CloseHandle refused"); };
  let failure: unknown;
  try { captureProcessWitnesses([42], box.api); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WitnessCaptureError);
  if (!(failure instanceof WitnessCaptureError)) throw new Error("Retryable ownership is missing");
  box.api.close = handle => { box.closed.push(handle); };
  failure.close();
  expect(box.closed).toEqual([1042]);
});
