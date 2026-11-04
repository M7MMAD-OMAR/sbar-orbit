import { expect, test } from "bun:test";
import { join } from "node:path";
import { ManualAcceptanceBarrier } from "../experiments/efficiency-native-acceptance";

test("uncertain manual input/setup quarantines every later mutation and automatic closure", () => {
  for (const tool of ["orbit_act", "orbit_open", "orbit_handoff", "orbit_resume"]) {
    for (const outcome of ["transport", "error", "partial", "capture-failure"]) {
      const barrier = new ManualAcceptanceBarrier();
      expect(barrier.mayAutoClose()).toBe(true);
      if (outcome === "transport") barrier.failure(tool);
      else barrier.outcome(tool, outcome === "error", outcome === "partial" ? { ok: false } : outcome === "capture-failure" ? { captureError: {} } : {});
      expect(barrier.quarantined).toBe(true); expect(barrier.mayAutoClose()).toBe(false);
      for (const next of ["orbit_act", "orbit_open", "orbit_handoff", "orbit_resume"]) expect(() => barrier.admit(next)).toThrow("Uncertain effect quarantined");
      for (const read of ["internal_passive_observe", "orbit_observe", "orbit_handoff_candidates", "orbit_stop", "orbit_pause"]) expect(() => barrier.admit(read)).not.toThrow();
      barrier.outcome("internal_passive_observe", false, {});
      expect(barrier.mayAutoClose()).toBe(false); // A read ack cannot prove semantic reconciliation.
    }
  }
});

test("read-only failure does not manufacture an input uncertainty or grant mutation authority", () => {
  const barrier = new ManualAcceptanceBarrier();
  barrier.failure("internal_passive_observe");
  barrier.outcome("orbit_observe", true, {});
  expect(barrier.quarantined).toBe(false);
  expect(barrier.mayAutoClose()).toBe(true);
});

const linuxOnly = process.platform === "linux" ? test : test.skip;
const script = join(import.meta.dir, "../experiments/efficiency-native-acceptance.ts");
async function guard(args: string[], patch: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    env: { ...process.env, ORBIT_CONVERSATION_ID: "owned-guard-fixture", DSH_SESSION_ID: "owned-guard-fixture", ORBIT_ACCEPTANCE_WORKSPACE: undefined, ...patch },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe("");
  return { events: out.trim().split("\n").map(line => JSON.parse(line)), code };
}

test("manual native harness help performs no native operations and preserves default explicit workspace", async () => {
  const { events, code } = await guard(["--help"]);
  expect(code).toBe(0); expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: "usage", manualOnly: true, nativeOperations: false, workspace: 1, applicationId: "org.gnome.Calculator.desktop" });
});

test("manual native harness configured workspace is explicit, never automatic presentation", async () => {
  const { events, code } = await guard(["--help"], { ORBIT_ACCEPTANCE_WORKSPACE: "4" });
  expect(code).toBe(0); expect(events[0]).toMatchObject({ nativeOperations: false, workspace: 4 });
});

linuxOnly("native experiment refuses alternate conversation before importing/starting native controller", async () => {
  const { events, code } = await guard(["--run"], { ORBIT_CONVERSATION_ID: "alternate-scope" });
  expect(code).toBe(1); expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: "fatal", message: "Conversation scope must match this host session, not an invented or alternate scope" });
});

linuxOnly("native experiment refuses invalid workspace configuration before any native controller", async () => {
  for (const workspace of ["0", "-1", "1.5", " 4", "04", "NaN", "2147483648"]) {
    const { events, code } = await guard(["--run"], { ORBIT_ACCEPTANCE_WORKSPACE: workspace });
    expect(code).toBe(1); expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "fatal", message: "ORBIT_ACCEPTANCE_WORKSPACE must explicitly name a positive numbered workspace" });
  }
});

test("manual native harness unknown arguments never opt into native operations", async () => {
  const { events, code } = await guard(["--run", "--force"]);
  expect(code).toBe(2); expect(events).toHaveLength(1); expect(events[0].nativeOperations).toBe(false);
});
