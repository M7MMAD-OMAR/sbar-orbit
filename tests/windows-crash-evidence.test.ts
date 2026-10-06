import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { captureProcessWitnesses, WitnessCaptureError, type WitnessApi } from "./windows-process-witness";

function fixture() {
  const closed: number[] = [];
  let state: "alive" | "exited" = "alive";
  const api: WitnessApi = {
    open: pid => pid + 1000,
    identity: handle => ({ creationTicks: String(handle * 100), image: "chrome.exe" }),
    state: () => ({ state, exitCode: state === "alive" ? 259 : 1, exitTicks: state === "alive" ? "0" : "104300" }),
    close: handle => { closed.push(handle); },
  };
  return { api, closed, exit() { state = "exited"; } };
}

test("stable owned witnesses preserve creation identity and measure actual exit", () => {
  const box = fixture(), witnesses = captureProcessWitnesses([42], box.api);
  expect(witnesses.observe()).toEqual([{ pid: 42, creationTicks: "104200", image: "chrome.exe", state: "alive", exitCode: 259, exitTicks: "0" }]);
  box.exit();
  expect(witnesses.observe()).toEqual([{ pid: 42, creationTicks: "104200", image: "chrome.exe", state: "exited", exitCode: 1, exitTicks: "104300" }]);
  witnesses.close(); witnesses.close();
  expect(box.closed).toEqual([1042]);
  expect(() => witnesses.observe()).toThrow("closed");
});

test("unknown owned witness state fails measurement and still permits handle cleanup", () => {
  const box = fixture(), witnesses = captureProcessWitnesses([42], box.api);
  box.api.state = () => { throw new Error("WaitForSingleObject failed"); };
  expect(() => witnesses.observe()).toThrow("WaitForSingleObject failed");
  witnesses.close();
  expect(box.closed).toEqual([1042]);
});

test("partial witness capture releases every successfully opened handle", () => {
  const box = fixture();
  box.api.identity = handle => { if (handle === 1043) throw new Error("GetProcessTimes failed"); return { creationTicks: "1", image: "chrome.exe" }; };
  expect(() => captureProcessWitnesses([42, 43], box.api)).toThrow("GetProcessTimes failed");
  expect(box.closed).toEqual([1042, 1043]);
  box.closed.length = 0;
  box.api.open = pid => { if (pid === 43) throw new Error("OpenProcess failed"); return pid + 1000; };
  expect(() => captureProcessWitnesses([42, 43], box.api)).toThrow("OpenProcess failed");
  expect(box.closed).toEqual([1042]);
});

test("failed witness CloseHandle remains retryable and attempts all handles", () => {
  const box = fixture(), witnesses = captureProcessWitnesses([42, 43], box.api);
  box.api.close = handle => { if (handle === 1042) throw new Error("CloseHandle failed"); box.closed.push(handle); };
  expect(() => witnesses.close()).toThrow("cleanup failed");
  expect(box.closed).toEqual([1043]);
  box.api.close = handle => { box.closed.push(handle); };
  witnesses.close();
  expect(box.closed).toEqual([1043, 1042]);
});

test("capture failure preserves failed handle cleanup for the caller finally path", () => {
  const box = fixture();
  box.api.identity = () => { throw new Error("identity unknown"); };
  box.api.close = () => { throw new Error("close refused"); };
  let failure: unknown;
  try { captureProcessWitnesses([42], box.api); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WitnessCaptureError);
  if (!(failure instanceof WitnessCaptureError)) throw new Error("Witness cleanup retry missing");
  box.api.close = handle => { box.closed.push(handle); };
  failure.close();
  expect(box.closed).toEqual([1042]);
});

async function containment(env: Record<string, string>, members: number[], lines: string[]) {
  // Exercise the production assertion itself with numeric owned-only job mocks.
  const source = await readFile(process.env.ORBIT_CRASH_SOURCE || new URL("../src/chrome.ts", import.meta.url), "utf8");
  const windows = source.slice(source.indexOf("async function launchOnWindows"));
  const body = /    async assertContained\(\) \{([\s\S]*?)\n    \},/.exec(windows)?.[1];
  if (!body) throw new Error("Production Windows containment assertion was not found");
  return new Function("job", "child", "evidence", "process", "console", "OrbitError", `return (async () => {${body}})();`)(
    { processIds: () => members }, { pid: 42 }, { handleClosed: false }, { env },
    { error: (line: string) => lines.push(line) }, Error,
  );
}

test("Windows private job evidence is opt-in and includes root membership before crash", async () => {
  const lines: string[] = [];
  await containment({}, [42, 43], lines);
  expect(lines).toEqual([]);
  await containment({ ORBIT_WINDOWS_CRASH_EVIDENCE: "1" }, [42, 43], lines);
  expect(lines.map(line => JSON.parse(line))).toEqual([{ ownedBrowser: "crash evidence", rootPid: 42, members: [42, 43] }]);
});

test("private job diagnostics cannot convert missing root membership into a pass", async () => {
  const lines: string[] = [];
  await expect(containment({ ORBIT_WINDOWS_CRASH_EVIDENCE: "1" }, [43], lines)).rejects.toThrow();
});
