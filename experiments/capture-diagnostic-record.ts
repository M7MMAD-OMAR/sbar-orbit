// Job-log output accepts only explicitly typed diagnostic fields.
const phases = ["capture.budget", "observe.start", "observe.settled", "attachment.start", "attachment.settled",
  "screenshot.start", "screenshot.settled", "browser.identity.start", "browser.identity.settled",
  "browser.identity.bytes", "browser.connected", "backend.created.after-close", "registration.closed",
  "diagnostic.invalid", "mcp.result"];
const codes = ["TIMEOUT", "BACKEND_FAILED", "BACKEND_ERROR", "BROKER_UNAVAILABLE", "POLICY_DENIED",
  "SESSION_CLOSED", "SESSION_NOT_FOUND", "RESOURCE_LIMIT_REQUIRED", "USAGE_STATE_INVALID", "INVALID_REQUEST", "DEADLINE_EXCEEDED"];
const categories = ["capture timeout", "broker unavailable", "other error message", "unreadable error metadata", "unparseable error"];
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Fields = Record<string, unknown>;
function object(value: unknown): Fields { return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function choice(target: Fields, source: Fields, key: string, allowed: readonly string[]) {
  const value = source[key]; if (typeof value === "string" && allowed.includes(value)) target[key] = value;
}
function patterned(target: Fields, source: Fields, key: string, pattern: RegExp) {
  const value = source[key]; if (typeof value === "string" && pattern.test(value)) target[key] = value;
}
function event(value: unknown): Fields | undefined {
  const source = object(value), result: Fields = {};
  choice(result, source, "captureDiagnostic", phases);
  if (!result.captureDiagnostic) return;
  choice(result, source, "fixture", ["mcp", "observe-policy"]);
  choice(result, source, "status", ["fulfilled", "rejected"]);
  choice(result, source, "code", codes);
  choice(result, source, "messageCategory", categories);
  for (const key of ["request", "observation", "operation", "diagnosticId"]) patterned(result, source, key, uuid);
  for (const key of ["executableSha256", "messageSha256", "codeSha256", "textSha256"]) patterned(result, source, key, sha256);
  patterned(result, source, "version", /^\d+(?:\.\d+)+$/);
  for (const key of ["sequence", "monotonicMs", "elapsedMs", "budgetMs", "captureBudgetMs", "messageBytes", "textBytes"])
    if (finite(source[key])) result[key] = source[key];
  for (const key of ["invalid", "cleanupConfirmed", "isError"])
    if (typeof source[key] === "boolean") result[key] = source[key];
  if (Array.isArray(source.pending)) result.pending = source.pending.filter(v => typeof v === "string" && ["observe", "attachment", "screenshot", "browser.identity"].includes(v));
  if (Array.isArray(source.contentTypes)) result.contentTypes = source.contentTypes.filter(v => typeof v === "string" && ["text", "image", "audio", "resource", "resource_link"].includes(v));
  return result;
}
export function captureArmProjection(value: unknown, binding: unknown): Fields {
  const source = object(value), identity = object(binding), result: Fields = {};
  choice(result, source, "arm", ["isolated", "full-suite"]);
  patterned(result, identity, "sourceCommit", /^[a-f0-9]{40}$/);
  for (const key of ["sourceManifestSha256", "browserSha256"]) patterned(result, identity, key, sha256);
  patterned(result, identity, "browserVersion", /^\d+(?:\.\d+)+$/);
  if (typeof source.exitCode === "number" && Number.isSafeInteger(source.exitCode)) result.exitCode = source.exitCode;
  if (finite(source.durationMs)) result.durationMs = source.durationMs;
  for (const key of ["timedOut", "cleanupConfirmed", "sourceAndBrowserStable", "identityConfirmed", "invalid"])
    if (typeof source[key] === "boolean") result[key] = source[key];
  choice(result, source, "descendantCleanup", ["not measured after owned launcher termination", "fixture shutdown outcomes only; no survivor measurement"]);
  const events = Array.isArray(source.events) ? source.events : [];
  result.events = events.flatMap(value => { const projected = event(value); return projected ? [projected] : []; });
  result.omittedEventCount = events.length - (result.events as Fields[]).length;
  return result;
}
export function writeCaptureArmRecord(value: unknown, binding: unknown, write: (text: string) => unknown = console.log): void {
  try { write(JSON.stringify({ captureDiagnosticArm: captureArmProjection(value, binding) })); } catch {}
}
