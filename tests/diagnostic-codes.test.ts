/**
 * The diagnostics code allowlist against the codes `src/**` actually throws.
 *
 * `src/diagnostics.ts` records any unlisted code as `BACKEND_ERROR`, the unattributable failure
 * `src/ipc.ts` names. So a hand-written list that drifts from the source does not merely go stale, it
 * converts a refusal a person or an agent could act on into "something went wrong".
 *
 * It had drifted in BOTH directions, and the shape of the drift is why nobody noticed: `SESSION_LIMIT`
 * and `RESOURCE_LIMIT` were listed and thrown by nothing, while `LIMIT_REACHED`, thrown by the 32
 * session, 10000 action, 64 tab and 32 application ceilings, was absent. The list LOOKED like it
 * covered limits. Measured through the real Diagnostics class before the fix: a thrown
 * `LIMIT_REACHED` was recorded as `BACKEND_ERROR`, and so were `RESOURCE_EXHAUSTED` and
 * `RESTORE_REFUSED`.
 *
 * This reads the source rather than restating the list, because a test that repeats the list by hand
 * is a second copy of the same mistake.
 */
import { test, expect } from "bun:test";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Diagnostics } from "../src/diagnostics";
import { OrbitError } from "../src/errors";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

/** Every code passed to `new OrbitError(...)` anywhere under src/, read from the files themselves. */
async function thrownCodes(): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const text = await readFile(path, "utf8");
      for (const match of text.matchAll(/new OrbitError\(\s*["']([A-Z_]+)["']/g)) found.add(match[1]!);
    }
  };
  await walk(sourceRoot);
  return found;
}

/**
 * Codes deliberately listed that no source throws. Empty on purpose: `SESSION_LIMIT` and
 * `RESOURCE_LIMIT` were removed rather than parked here, because a code nothing throws cannot be
 * recorded and its only effect was to make the list look complete. A future entry belongs here WITH
 * the reason it is expected, so the next person can tell an intention from a leftover.
 */
const listedButNeverThrown = new Map<string, string>([]);

/**
 * Codes thrown but deliberately unlisted. `BACKEND_ERROR` is what the layer falls back to, so it is
 * listed; there is nothing here that should be hidden behind it.
 */
const thrownButDeliberatelyUnlisted = new Map<string, string>([]);

test("every code the source throws is one the diagnostics layer can record", async () => {
  const { diagnosticCodes } = await import("../src/diagnostics");
  const thrown = await thrownCodes();
  // The probe is only meaningful if it found the codes at all.
  expect(thrown.size).toBeGreaterThan(20);
  expect(thrown.has("LIMIT_REACHED")).toBe(true);

  const missing = [...thrown].filter(code => !diagnosticCodes.has(code) && !thrownButDeliberatelyUnlisted.has(code)).sort();
  expect(missing).toEqual([]);
});

test("every code the allowlist carries is one the source can throw", async () => {
  // The other direction, and the one that let the first defect hide: a list padded with codes nobody
  // throws reads as covering more than it does.
  const { diagnosticCodes } = await import("../src/diagnostics");
  const thrown = await thrownCodes();
  const phantom = [...diagnosticCodes].filter(code => !thrown.has(code) && !listedButNeverThrown.has(code)).sort();
  expect(phantom).toEqual([]);
});

test("a thrown ceiling is recorded under its own name rather than as BACKEND_ERROR", async () => {
  // End to end through the real class, because the two tests above compare a list with a regex and
  // would both pass against a layer that never consulted the list at all.
  // A throwaway root, so this never writes into the person's own diagnostics directory.
  const root = await mkdtemp(join(tmpdir(), "orbit-diag-codes-"));
  const diagnostics = new Diagnostics(root);
  const recorded: string[] = [];
  for (const code of ["LIMIT_REACHED", "RESOURCE_EXHAUSTED", "RESTORE_REFUSED", "POLICY_DENIED"]) {
    try {
      await diagnostics.run({ method: "session.act", params: {} }, async () => { throw new OrbitError(code, "ceiling"); });
    } catch { /* the throw is the point */ }
  }
  const report = await diagnostics.report() as { events?: { code?: string }[] };
  for (const event of report.events ?? []) if (event.code) recorded.push(event.code);
  expect(recorded).toEqual(["LIMIT_REACHED", "RESOURCE_EXHAUSTED", "RESTORE_REFUSED", "POLICY_DENIED"]);
  // And the negative: a code that is genuinely not Orbit's still falls back, so the allowlist is
  // doing filtering rather than passing everything through.
  const fallback = new Diagnostics(await mkdtemp(join(tmpdir(), "orbit-diag-fallback-")));
  try {
    await fallback.run({ method: "session.act", params: {} }, async () => { throw new OrbitError("NOT_A_REAL_ORBIT_CODE", "x"); });
  } catch { /* expected */ }
  const second = await fallback.report() as { events?: { code?: string }[] };
  expect((second.events ?? []).filter(e => e.code).map(e => e.code)).toEqual(["BACKEND_ERROR"]);
  await rm(root, { recursive: true, force: true });
});
