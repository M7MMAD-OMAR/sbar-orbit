import { BrowserBackend } from "./browser";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

export type CaptureLabel = "unlabelled" | "first-popup" | "after-close" | "permitted-frame" | "denied-after-narrow";
export type CaptureStage = "begin" | "attachment-before" | "attachment-settled" | "attachment-rejected" | "screenshot-before" | "screenshot-settled" | "screenshot-rejected" | "timer-fired" | "race-settled" | "race-rejected" | "cleanup" | "detach-dispatched" | "detach-rejected" | "presence-before" | "presence-settled" | "presence-rejected";
type Pending = "attachment" | "screenshot" | "presence" | "screenshot+presence" | "none";
export interface CaptureRow { sequence: number; operation: number; page: number; label: CaptureLabel; stage: CaptureStage; pending: Pending; expired: boolean; cached: boolean; budget: number; elapsedMs: number; late: boolean }
type Sink = (value: CaptureRow) => void;
interface Registration { context: object | undefined; closed: boolean; label: CaptureLabel; pages: WeakMap<object, number>; nextPage: number; nextOperation: number; active: number; dropped: number; firstDropped: number | undefined; lastDropped: number | undefined; failed: number; rows: CaptureRow[]; sequence: number; sink: Sink }
export interface NavigationRow { sequence: number; operation: number; page: number; stage: "before" | "settled" | "rejected"; elapsedMs: number; late: boolean; error?: { name: "TimeoutError" | "other"; api: "page.goto" | "not measured"; timeoutMs: number | null; callLog: ("navigation dispatched, destination redacted" | "domcontentloaded observed" | "load observed" | "commit observed" | "redacted")[]; truncated: boolean } }
interface NavigationState { sequence: number; operation: number; active: number; dropped: number; rows: NavigationRow[] }
const navigations = new WeakMap<Registration, NavigationState>();
const registrations = new WeakMap<object, Registration>();
let activeRegistrations = 0;

/** Withdraw admission synchronously while keeping previously admitted recorder state. */
export function revokeBrowserPhases(backend: object) {
  const state = registrations.get(backend);
  if (!state || state.closed) return;
  state.closed = true;
  state.context = undefined;
  registrations.delete(backend);
  activeRegistrations--;
}

/** Fixture-owned direct capability, independent of HTTP async context. No path enters emitted rows. */
export function registerBrowserPhases(backend: object, context: object, workspace: string, profile: string, sink: Sink) {
  try {
    if (activeRegistrations >= 8 || registrations.has(backend) || !isAbsolute(workspace) || !isAbsolute(profile)) return;
    const owner = lstatSync(workspace), child = lstatSync(profile);
    if (!owner.isDirectory() || !child.isDirectory() || owner.isSymbolicLink() || child.isSymbolicLink()) return;
    if (realpathSync(workspace) !== workspace || realpathSync(profile) !== profile || dirname(profile) !== workspace || !basename(profile).startsWith("profile-")) return;
    if (process.platform !== "win32" && (owner.uid !== process.getuid?.() || child.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0 || (child.mode & 0o077) !== 0)) return;
    if (!BrowserBackend.phaseOwnershipMatches(backend, context, workspace, profile)) return;
    const boundContext = Object.getOwnPropertyDescriptor(backend, "context");
    if (!boundContext || !("value" in boundContext) || boundContext.value !== context) return;
    const state: Registration = { context, closed: false, label: "unlabelled", pages: new WeakMap(), nextPage: 0, nextOperation: 0, active: 0, dropped: 0, firstDropped: undefined, lastDropped: undefined, failed: 0, rows: [], sequence: 0, sink };
    registrations.set(backend, state); activeRegistrations++;
    const navigation: NavigationState = { sequence: 0, operation: 0, active: 0, dropped: 0, rows: [] };
    navigations.set(state, navigation);
    return {
      label(value: CaptureLabel) { if (!state.closed) state.label = value; },
      snapshot() { return { rows: [...state.rows], retention: { first: 32, recent: 96, emitted: state.sequence, firstDropped: state.firstDropped, lastDropped: state.lastDropped }, pending: state.active, dropped: state.dropped, sinkFailures: state.failed, complete: state.dropped === 0 && state.failed === 0 && state.active === 0,
        navigation: { rows: structuredClone(navigation.rows), pending: navigation.active, dropped: navigation.dropped, emitted: navigation.sequence, complete: navigation.active === 0 && navigation.dropped === 0 } }; },
      close() { if (!state.closed) revokeBrowserPhases(backend); },
    };
  } catch { return; }
}

/** Only the original goto timeout header and fixed call-log milestones survive. No raw error text. */
function navigationError(error: unknown): NonNullable<NavigationRow["error"]> {
  const result: NonNullable<NavigationRow["error"]> = { name: "other", api: "not measured", timeoutMs: null, callLog: [], truncated: false };
  try {
    if (!(error instanceof Error)) return result;
    result.name = error.name === "TimeoutError" ? "TimeoutError" : "other";
    const message = error.message;
    result.truncated = message.length > 8192;
    const lines = message.slice(0, 8192).split("\n");
    const header = lines[0]?.match(/^page\.goto: Timeout ([0-9]{1,8})ms exceeded\.$/);
    if (header) { result.api = "page.goto"; result.timeoutMs = Number(header[1]); }
    const marker = lines.indexOf("Call log:");
    if (marker < 0) return result;
    for (const line of lines.slice(marker + 1, marker + 17)) {
      if (!line.trim()) continue;
      if (/^\s*- navigating to ".*", waiting until "domcontentloaded"$/.test(line)) result.callLog.push("navigation dispatched, destination redacted");
      else if (/^\s*- "domcontentloaded" event fired$/.test(line)) result.callLog.push("domcontentloaded observed");
      else if (/^\s*- "load" event fired$/.test(line)) result.callLog.push("load observed");
      else if (/^\s*- "commit" event fired$/.test(line)) result.callLog.push("commit observed");
      else result.callLog.push("redacted");
    }
    result.truncated ||= lines.length > marker + 17;
  } catch { result.truncated = true; }
  return result;
}

/** Reuses exact factory ownership admission, with no URL, action text, screenshot or presence reads. */
export function beginBrowserNavigation(backend: object, context: () => object, page: object) {
  try {
    const state = registrations.get(backend);
    if (!state || state.closed || state.context !== context()) return;
    const navigation = navigations.get(state);
    if (!navigation) return;
    if (navigation.active >= 16) { navigation.dropped++; return; }
    let ordinal = state.pages.get(page);
    if (ordinal === undefined) { ordinal = ++state.nextPage; state.pages.set(page, ordinal); }
    const pageOrdinal = ordinal, operation = ++navigation.operation, started = performance.now();
    navigation.active++;
    const mark = (stage: NavigationRow["stage"], error?: unknown) => {
      const row: NavigationRow = { sequence: ++navigation.sequence, operation, page: pageOrdinal, stage, elapsedMs: Math.round(performance.now() - started), late: state.closed,
        ...(stage === "rejected" ? { error: navigationError(error) } : {}) };
      if (navigation.rows.length >= 128) { navigation.rows.splice(32, 1); navigation.dropped++; }
      navigation.rows.push(row);
    };
    mark("before");
    let finished = false;
    return { finish(error?: unknown, rejected = false) {
      if (finished) return;
      finished = true;
      try { mark(rejected ? "rejected" : "settled", error); } catch { navigation.dropped++; }
      finally { navigation.active--; }
    } };
  } catch { return; }
}

/** The admitted operation keeps only a recorder state, never backend, context or page references. */
export function beginBrowserCapture(backend: object, context: object | (() => object), page: object, budget: number, cached: boolean) {
  try {
  const state = registrations.get(backend);
  if (!state || state.closed) return;
  try { if (state.context !== (typeof context === "function" ? context() : context)) return; }
  catch { state.failed++; return; }
  if (state.active >= 16) { state.dropped++; return; }
  let ordinal = state.pages.get(page);
  if (ordinal === undefined) { ordinal = ++state.nextPage; state.pages.set(page, ordinal); }
  const pageOrdinal = ordinal, operation = ++state.nextOperation, label = state.label, started = performance.now();
  state.active++;
  let pending: Pending = "attachment", expired = false, finished = false;
  let pixelsPending = false, presencePending = false;
  const mark = (stage: CaptureStage) => {
    try {
      if (stage === "attachment-settled" || stage === "attachment-rejected") pending = "none";
      if (stage === "screenshot-before") pixelsPending = true;
      if (stage === "screenshot-settled" || stage === "screenshot-rejected") pixelsPending = false;
      if (stage === "presence-before") presencePending = true;
      if (stage === "presence-settled" || stage === "presence-rejected") presencePending = false;
      if (pixelsPending || presencePending || pending !== "attachment")
        pending = pixelsPending && presencePending ? "screenshot+presence"
          : pixelsPending ? "screenshot" : presencePending ? "presence" : "none";
      if (stage === "timer-fired") expired = true;
      const row: CaptureRow = { sequence: ++state.sequence, operation, page: pageOrdinal, label, stage, pending, expired, cached, budget, elapsedMs: Math.round(performance.now() - started), late: state.closed };
      if (state.rows.length >= 128) {
        const displaced = state.rows.splice(32, 1)[0];
        if (displaced) { state.dropped++; state.firstDropped ??= displaced.sequence; state.lastDropped = displaced.sequence; }
      }
      state.rows.push(row);
      try { state.sink(row); } catch { state.failed++; }
    } catch { state.failed++; }
  };
  mark("begin");
  return { mark, finish() { if (!finished) { finished = true; state.active--; pending = "none"; } } };
  } catch { return; }
}

/** Only fixed Python stages and integer clocks can cross the private sidecar boundary. */
export function classifyPipePhases(text: string | undefined, exit: number | null) {
  const unknown = { exit, status: "not measured", complete: false, rows: [] as { phase: string; monotonicNs: number }[] };
  if (text === undefined || Buffer.byteLength(text) > 8192 || !text.trim()) return unknown;
  try {
    const allowed = new Set(["entered", "spawned", "delay-complete", "communicate-before", "communicate-settled", "communicate-timeout", "kill-dispatched", "drain-before", "drain-settled", "output-write-before", "output-write-settled"]);
    const parsed: unknown[] = text.trim().split("\n").map(line => JSON.parse(line));
    if (parsed.length > 20) return unknown;
    const rows: { phase: string; monotonicNs: number }[] = [];
    for (const row of parsed) {
      if (typeof row !== "object" || row === null || Array.isArray(row) || Object.keys(row).some(key => key !== "phase" && key !== "monotonicNs")) return unknown;
      const fields = row as { phase?: unknown; monotonicNs?: unknown };
      if (typeof fields.phase !== "string" || !allowed.has(fields.phase) || typeof fields.monotonicNs !== "number" || !Number.isSafeInteger(fields.monotonicNs) || fields.monotonicNs < 0) return unknown;
      rows.push({ phase: fields.phase, monotonicNs: fields.monotonicNs });
    }
    const successful = ["entered", "spawned", "delay-complete", "communicate-before", "communicate-settled", "output-write-before", "output-write-settled"];
    const ordered = rows.length === successful.length && rows.every((row, index) => row.phase === successful[index] && (index === 0 || row.monotonicNs >= (rows[index - 1]?.monotonicNs ?? Infinity)));
    return { exit, status: "fixed phases observed", complete: exit === 0 && ordered, rows };
  } catch { return unknown; }
}
