import { expect, test } from "bun:test";
import { captureArmProjection, writeCaptureArmRecord } from "../experiments/capture-diagnostic-record";

test("job-log projection rejects arbitrary private fields and values while retaining typed phase evidence", () => {
  const privateValue = "/home/example/private-profile token=private-token https://private.example/endpoint";
  const digest = "a".repeat(64), sourceCommit = "b".repeat(40);
  const record = { arm: "isolated", exitCode: 2, durationMs: 3001, timedOut: false, cleanupConfirmed: false,
    sourceAndBrowserStable: true, identityConfirmed: true, invalid: false, argv: [privateValue], message: privateValue,
    events: [{ captureDiagnostic: "screenshot.settled", fixture: "mcp", status: "rejected", elapsedMs: 3000,
      code: "TIMEOUT", messageCategory: "capture timeout", messageSha256: digest, captureBudgetMs: 3000,
      message: privateValue, image: privateValue, executable: privateValue },
      { captureDiagnostic: privateValue, code: privateValue },
      { captureDiagnostic: "mcp.result", code: privateValue, messageCategory: privateValue, request: privateValue,
        messageSha256: privateValue, contentTypes: ["text", privateValue], pending: ["attachment", privateValue] }] };
  const projected = captureArmProjection(record, { sourceCommit, sourceManifestSha256: digest, browserSha256: digest,
    browserVersion: "154.0.8037.97", executable: privateValue });
  expect(projected).toMatchObject({ arm: "isolated", exitCode: 2, sourceCommit, omittedEventCount: 1 });
  expect(projected.events).toEqual([
    { captureDiagnostic: "screenshot.settled", fixture: "mcp", status: "rejected", elapsedMs: 3000,
      code: "TIMEOUT", messageCategory: "capture timeout", messageSha256: digest, captureBudgetMs: 3000 },
    { captureDiagnostic: "mcp.result", contentTypes: ["text"], pending: ["attachment"] }]);
  expect(JSON.stringify(projected)).not.toContain(privateValue);
  expect(JSON.stringify(projected)).not.toMatch(/argv|executable|image|private-token|private\.example/);
  expect(record.events).toHaveLength(3);
});

test("job-log observer failure cannot throw or mutate the original arm outcome", () => {
  const record = { arm: "isolated", exitCode: 2, timedOut: true, events: [] };
  const before = JSON.stringify(record);
  expect(() => writeCaptureArmRecord(record, {}, () => { throw new Error("sink failure"); })).not.toThrow();
  const hostile = Object.defineProperty({}, "arm", { get() { throw new Error("unreadable metadata"); } });
  expect(() => writeCaptureArmRecord(hostile, {})).not.toThrow();
  expect(JSON.stringify(record)).toBe(before);
});
