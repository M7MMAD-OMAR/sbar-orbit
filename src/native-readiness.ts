import { join } from "node:path";
import { OrbitError } from "./errors";
import { nativeStateRoot, refreshNative, runOwnerCommand } from "./native-prepare";
import type { NativeOptions } from "./native-worker";

export interface NativeProblem { code: string; blocking: boolean; message: string; fix: string }
export interface NativeReadiness {
  ready: boolean; selfRepairable: boolean; problems: NativeProblem[];
  environment: { resolved: boolean; source: string; values: Record<string, string>; missing_from_process: string[]; instances: string[] };
  compositor: { version: string; commit: string; abiHash: string; signature: string } | null;
  installed: { version: string | null } | null;
  plan: { version: string; abiHash: string; signature: string } | null;
  build: { version: string; abiHash: string; sourceCurrent: boolean } | null;
  plugin: { loaded: boolean | null };
  lastRefresh: { at: string; ok: boolean; message: string } | null;
}

/** Ask the owner-side checker whether compositor, plan, plugin build and loaded plugin agree. Read-only. */
export async function diagnoseNative(root = nativeStateRoot()): Promise<NativeReadiness> {
  const { code, reply } = await runOwnerCommand("diagnose.py", [root]);
  if (code !== 0 || typeof reply !== "object" || reply === null || !("problems" in reply))
    throw new OrbitError("BACKEND_FAILED", "Native readiness check did not return a report");
  return reply as NativeReadiness;
}

// Incompatible: a binary or compositor version problem that needs a rebuild or a new login.
const incompatible = new Set(["PLUGIN_ABI_MISMATCH", "PLUGIN_SOURCE_CHANGED", "PLUGIN_BUILD_MISSING", "COMPOSITOR_NOT_RESTARTED"]);

/** One actionable refusal naming the first blocking disagreement and the command that fixes it. */
export function readinessFailure(report: NativeReadiness, requirePlugin = true): OrbitError {
  const blocking = blockers(report, requirePlugin);
  const first = blocking[0];
  const rest = blocking.length > 1 ? ` (${blocking.length - 1} more: ${blocking.slice(1).map(problem => problem.code).join(", ")}; run sbar-orbit doctor)` : "";
  const text = first ? `${first.message} Fix: ${first.fix}${rest}` : "Native control is not ready; run sbar-orbit doctor for the exact mismatch.";
  const refresh = report.lastRefresh && !report.lastRefresh.ok ? ` Last native-refresh failed at ${report.lastRefresh.at}: ${report.lastRefresh.message}` : "";
  const message = (text + refresh).replace(/[^\x20-\x7e]/g, " ").slice(0, 900);
  return first && incompatible.has(first.code) ? new OrbitError("NATIVE_INCOMPATIBLE", message) : new OrbitError("NATIVE_STALE", message);
}

/** Blocking problems for this operation; reading monitors needs a current plan but no loaded plugin. */
function blockers(report: NativeReadiness, requirePlugin: boolean) {
  return report.problems.filter(problem => problem.blocking && (requirePlugin || !problem.code.startsWith("PLUGIN_")));
}

let repair: Promise<void> | undefined;
let lastFailure = 0;
const cooldownMs = 30_000;

/**
 * Before a native worker is started: make the plan current if only the compositor restarted, and
 * refuse early with the exact mismatch when it cannot be repaired here (a new compositor ABI needs a
 * rebuilt plugin; an upgrade needs a new login). Only the owner's real state directory is checked, so
 * fixture plans used by tests are untouched.
 */
export async function ensureNativeReady(options: NativeOptions, deps: { diagnose?: typeof diagnoseNative; refresh?: typeof refreshNative; root?: string; requirePlugin?: boolean } = {}) {
  const requirePlugin = deps.requirePlugin ?? true;
  const ok = (value: NativeReadiness) => requirePlugin ? value.ready : blockers(value, false).length === 0 && value.plan !== null;
  const root = deps.root ?? nativeStateRoot();
  if (options.planPath !== join(root, "current", "host.json")) return;
  const diagnose = deps.diagnose ?? diagnoseNative, refresh = deps.refresh ?? refreshNative;
  let report = await diagnose(root);
  if (ok(report)) return;
  if (report.selfRepairable && Date.now() - lastFailure > cooldownMs) {
    repair ??= (async () => { try { await refresh(undefined, true); } catch { lastFailure = Date.now(); } })().finally(() => { repair = undefined; });
    await repair;
    report = await diagnose(root);
    if (ok(report)) return;
  }
  throw readinessFailure(report, requirePlugin);
}

export function resetNativeReadinessForTests() { repair = undefined; lastFailure = 0; }
