import { expect, test } from "bun:test";
import { navigationFixtureDiagnostic } from "./navigation-fixture-diagnostic";

test("static navigation fixture receipts omit credentials query fragment headers and arbitrary route text", () => {
  const diagnostic = navigationFixtureDiagnostic();
  diagnostic.phase("fixture-ready");
  diagnostic.request("http://user:password@127.0.0.1:1234/form?secret=token#fragment");
  diagnostic.request("http://127.0.0.1:1234/next?private=hidden");
  diagnostic.request("http://127.0.0.1:1234/arbitrary-private-route");
  diagnostic.phase("failure");
  const snapshot = diagnostic.snapshot();
  expect(snapshot.requests.map(row => row.route)).toEqual(["form", "next", "other"]);
  expect(snapshot.phases.map(row => row.phase)).toEqual(["fixture-ready", "failure"]);
  expect(snapshot.failed).toBe(true); expect(snapshot.cleanupSettled).toBe(false);
  for (const privateText of ["password", "secret", "token", "fragment", "hidden", "127.0.0.1", "arbitrary-private-route"]) expect(JSON.stringify(snapshot)).not.toContain(privateText);
});

test("static navigation fixture receipts remain bounded and snapshots cannot alter retained evidence", () => {
  const diagnostic = navigationFixtureDiagnostic();
  for (let index = 0; index < 200; index++) diagnostic.request("http://127.0.0.1:1234/form");
  const first = diagnostic.snapshot();
  expect(first.requests).toHaveLength(128); expect(first.requestCount).toBe(200); expect(first.droppedRequests).toBe(72);
  first.requests.length = 0; first.phases.push({ phase: "cleanup-settled", elapsedMs: 0 });
  const final = diagnostic.snapshot();
  expect(final.requests).toHaveLength(128); expect(final.phases).toEqual([]); expect(final.cleanupSettled).toBe(false);
});
