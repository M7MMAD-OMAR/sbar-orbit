import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collector } from "../experiments/browser-performance";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("the production process-tree collector requires Linux prctl and proc identity evidence; these simulations cover only that collector");

type ContractResult = {
  case: string;
  expectedAccepted: boolean;
  accepted: boolean;
  contractMatches: boolean;
  sampleError: { type: string; message: string } | null;
  subsequentAbsencePreserved?: boolean;
};

test("collector preserves closure evidence and rejects changed terminal identity", () => {
  // Only the two collector helpers execute, with simulated process and file IO.
  // Feeding the production export makes this fail against the unfixed collector.
  const fixture = fileURLToPath(new URL("./fixtures/browser-performance-collector.py", import.meta.url));
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-B", fixture], {
    input: collector, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout) as { results: ContractResult[]; contractMatches: boolean; diagnostics: { case: string; firstBrowserRejection: unknown; firstRejectionPreserved: boolean; identityRejected: boolean; commandsCleared: boolean }[] };
  expect(report.results).toHaveLength(32);
  const mismatches = report.results.filter(row => !row.contractMatches).map(row => ({
    case: row.case, expectedAccepted: row.expectedAccepted, accepted: row.accepted,
    sampleError: row.sampleError,
  }));
  expect(mismatches).toEqual([]);
  expect(report.contractMatches).toBe(true);
  expect(result.status).toBe(0);
  for (const row of report.results) {
    expect({ case: row.case, accepted: row.accepted }).toEqual({ case: row.case, accepted: row.expectedAccepted });
    if (row.subsequentAbsencePreserved !== undefined) expect(row.subsequentAbsencePreserved).toBe(true);
  }
  expect(report.diagnostics.find(row => row.case === "owner_read")).toEqual({
    case: "owner_read", firstBrowserRejection: { stage: "owner_read", exceptionClass: "OSError",
      errno: 13, priorPinObserved: true, censusIdentity: { pid: 171, parent: 170, start: 2000, kernelState: "S" } },
    firstRejectionPreserved: true, identityRejected: true, commandsCleared: true,
  });
  expect(report.diagnostics.find(row => row.case === "live_executable")).toEqual({
    case: "live_executable", firstBrowserRejection: { stage: "live_executable", exceptionClass: "ValueError",
      errno: null, priorPinObserved: true, censusIdentity: { pid: 171, parent: 170, start: 2000, kernelState: "S" } },
    firstRejectionPreserved: true, identityRejected: true, commandsCleared: true,
  });
}, 10_000);
