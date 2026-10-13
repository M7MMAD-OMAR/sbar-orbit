import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserBackend } from "../src/browser";
import { registerBrowserPhases } from "../src/browser-phase-observer";
import type { startBroker } from "../src/ipc";

type Phase = "fixture-ready" | "session-create-before" | "session-create-settled" | "initial-navigate-before" | "initial-navigate-settled" | "presence-assertions-before" | "presence-assertions-settled" | "next-navigate-before" | "next-navigate-settled" | "failure" | "cleanup-before" | "cleanup-settled";
/** One static fixture and its exact fresh target. Never the viewer, native or personal browser. */
export function navigationFixtureDiagnostic() {
  const started = performance.now();
  const phases: { phase: Phase; elapsedMs: number }[] = [];
  const requests: { sequence: number; route: "form" | "next" | "other"; elapsedMs: number }[] = [];
  let requestCount = 0, droppedRequests = 0;
  let registration: ReturnType<typeof registerBrowserPhases>;
  let admission: "not attempted" | "admitted" | "refused" = "not attempted";
  let failed = false, cleanupSettled = false;
  const phase = (value: Phase) => { if (phases.length < 32) phases.push({ phase: value, elapsedMs: Math.round(performance.now() - started) }); if (value === "failure") failed = true; if (value === "cleanup-settled") cleanupSettled = true; };
  const snapshot = () => structuredClone({ phases, requests, requestCount, droppedRequests, failed, cleanupSettled });
  return {
    phase,
    snapshot,
    request(url: string) {
      let route: "form" | "next" | "other" = "other";
      try { const path = new URL(url).pathname; if (path === "/form") route = "form"; else if (path === "/next") route = "next"; } catch {}
      const row = { sequence: ++requestCount, route, elapsedMs: Math.round(performance.now() - started) };
      if (requests.length < 128) requests.push(row); else droppedRequests++;
    },
    attach(broker: Awaited<ReturnType<typeof startBroker>>, sessionId: string) {
      try {
        const owned = broker.sessions["get"](sessionId);
        if (!(owned.backend instanceof BrowserBackend)) { admission = "refused"; return; }
        registration = registerBrowserPhases(owned.backend, owned.backend.context, broker.sessions["root"], owned.profile, () => {});
        admission = registration ? "admitted" : "refused";
      } catch { admission = "refused"; }
    },
    async save() {
      try {
        const sourceNames = ["src/browser.ts", "src/browser-phase-observer.ts", "src/session.ts", "src/ipc.ts", "tests/workspace-presence.test.ts", "tests/navigation-fixture-diagnostic.ts", "tests/browser-phase-observer-controlled-child.ts", "tests/browser-phase-observer.test.ts", "package.json", "bun.lock", ".github/workflows/verify.yml"];
        const sources = [];
        for (const path of sourceNames) { const bytes = await readFile(new URL("../" + path, import.meta.url)); sources.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); }
        const observed = registration?.snapshot();
        const report = { schema: 1, fixture: "static-workspace-presence", source: { providerCheckout: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "not measured", files: sources }, runtime: { platform: process.platform, bun: Bun.version }, admission, ...snapshot(), navigation: observed?.navigation ?? "not measured", capture: observed ? { rows: observed.rows, retention: observed.retention, rowCount: observed.rows.length, pending: observed.pending, dropped: observed.dropped, sinkFailures: observed.sinkFailures, complete: observed.complete } : "not measured",
          limits: ["Navigation observation is diagnostic only and adds no retry or deadline.", "Timeout detail is the original Playwright header and fixed call-log milestones only; destinations, arbitrary text, stack and page content are redacted.", "Fixture receipts prove callback entry, not browser rendering or root cause.", "Presence assertions, screenshots and pointer correctness require their actual test results; no images or presence content enter this report.", "A settled broker.close phase is not independent process exit or cleanup proof.", "Source hashes describe files read at save, not compiled runtime or browser executable identity."] };
        const sourceRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
        let directory = sourceRoot;
        for (const segment of ["output", "navigation-diagnostic"]) {
          directory = join(directory, segment);
          try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Diagnostic output is not owned");
          if (process.platform !== "win32" && info.uid !== process.getuid?.()) throw new Error("Diagnostic output owner differs");
        }
        await writeFile(join(directory, `workspace-presence-${crypto.randomUUID()}.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        console.error(JSON.stringify({ navigationFixtureDiagnostic: "saved", admission, requestCount, droppedRequests, failed, cleanupSettled }));
      } catch { console.error(JSON.stringify({ navigationFixtureDiagnostic: "write failed", status: "not measured" })); }
      finally { registration?.close(); }
    },
  };
}
