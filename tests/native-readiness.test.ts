import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrbitError } from "../src/errors";
import { Diagnostics, orbitCause } from "../src/diagnostics";
import { withCleanup } from "../src/hyprland";
import { workerFailureDetail } from "../src/native-worker";
import { ensureNativeReady, readinessFailure, resetNativeReadinessForTests, type NativeReadiness } from "../src/native-readiness";
import { describeDesktopMachine } from "../src/desktop-machine";
import { brokerNotListening, callPatient } from "../src/ipc";

const scratch = async () => mkdtemp(join(process.env.HOME ?? "/home", ".cache/sbar-orbit/tmp-test-"));

function report(overrides: Partial<NativeReadiness> = {}): NativeReadiness {
  return {
    ready: false, selfRepairable: false, problems: [], lastRefresh: null,
    environment: { resolved: true, source: "runtime-scan", values: { WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "Hyprland" }, missing_from_process: ["WAYLAND_DISPLAY"], instances: ["x"] },
    compositor: null, installed: null, plan: { version: "0.56.2", abiHash: "a", signature: "s" }, build: null, plugin: { loaded: null }, ...overrides,
  };
}
const abiMismatch = { code: "PLUGIN_ABI_MISMATCH", blocking: true, message: "The recorded plugin was built for Hyprland 0.56.2 but the running compositor is 0.57.0.", fix: "Rebuild for 0.57.0 and run: sbar-orbit native-refresh --plugin-manifest ABSOLUTE_PRIVATE_JSON" };
const planStale = { code: "PLAN_STALE", blocking: true, message: "The prepared native plan is stale.", fix: "Run: sbar-orbit native-refresh" };

test("a failed cleanup keeps the classified refusal and its code", async () => {
  const refusal = new OrbitError("NATIVE_STALE", "run sbar-orbit native-refresh");
  const wrapped = withCleanup(refusal, [new Error("rm failed")], "cleanup");
  expect(wrapped).toBe(refusal);
  expect(orbitCause(new AggregateError([new Error("x"), refusal]))).toBe(refusal);
  const root = await scratch();
  try {
    const diagnostics = new Diagnostics(root);
    await expect(diagnostics.run({ method: "native.candidates", params: {} }, async () => { throw withCleanup(refusal, [new Error("rm failed")], "cleanup"); }))
      .rejects.toMatchObject({ code: "NATIVE_STALE", message: "run sbar-orbit native-refresh" });
    const events = (await diagnostics.report()).events.filter(event => event.outcome === "error");
    expect(events[0]).toMatchObject({ method: "native.candidates", code: "NATIVE_STALE", detail: "run sbar-orbit native-refresh" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unclassified error is still reported as a failed request", async () => {
  const root = await scratch();
  try {
    await expect(new Diagnostics(root).run({ method: "doctor" }, async () => { throw new AggregateError([new Error("boom")], "x"); }))
      .rejects.toMatchObject({ code: "BACKEND_ERROR", message: "Request failed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a dying worker's cause is read back from its journal, bounded and printable", async () => {
  const root = await scratch();
  try {
    const log = join(root, "worker.log");
    await writeFile(log, "Traceback (most recent call last):\n  File \"x.py\", line 1\nModuleNotFoundError: No module named 'gi'\n");
    expect(workerFailureDetail(log)).toBe("ModuleNotFoundError: No module named 'gi'");
    await writeFile(log, "Traceback\nsrc.native.host.HostError: raw\nORBIT-WORKER-FATAL " + JSON.stringify({ type: "HostError", message: "Compositor endpoint is gone; run sbar-orbit native-refresh\u0007" }) + "\n");
    expect(workerFailureDetail(log)).toBe("HostError: Compositor endpoint is gone; run sbar-orbit native-refresh");
    await writeFile(log, "x".repeat(20000) + "\nValueError: " + "y".repeat(2000) + "\n");
    expect(workerFailureDetail(log)!.length).toBeLessThanOrEqual(300);
    expect(workerFailureDetail(join(root, "missing.log"))).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an upgraded compositor is refused early with both versions and the rebuild command", () => {
  const failure = readinessFailure(report({ problems: [abiMismatch, planStale] }));
  expect(failure.code).toBe("NATIVE_INCOMPATIBLE");
  expect(failure.message).toContain("0.56.2");
  expect(failure.message).toContain("0.57.0");
  expect(failure.message).toContain("native-refresh --plugin-manifest");
  expect(failure.message).toContain("1 more: PLAN_STALE");
});

test("a restarted compositor is repaired once, shared by concurrent callers, then proceeds", async () => {
  resetNativeReadinessForTests();
  const root = "/state";
  const options = { planPath: join(root, "current", "host.json"), controlDirectory: join(root, "control") };
  let refreshed = 0;
  const diagnose = async () => refreshed > 0 ? report({ ready: true }) : report({ selfRepairable: true, problems: [planStale] });
  const refresh = async () => { refreshed++; await new Promise(resolve => setTimeout(resolve, 20)); return {}; };
  await Promise.all([ensureNativeReady(options, { root, diagnose, refresh }), ensureNativeReady(options, { root, diagnose, refresh })]);
  expect(refreshed).toBe(1);
});

test("a failed repair is not retried for thirty seconds and the refusal names the fix", async () => {
  resetNativeReadinessForTests();
  const root = "/state";
  const options = { planPath: join(root, "current", "host.json"), controlDirectory: join(root, "control") };
  let refreshed = 0;
  const stale = report({ selfRepairable: true, problems: [planStale] });
  const deps = { root, diagnose: async () => stale, refresh: async () => { refreshed++; throw new OrbitError("CONFIG_REQUIRED", "refresh failed"); } };
  await expect(ensureNativeReady(options, deps)).rejects.toMatchObject({ code: "NATIVE_STALE" });
  await expect(ensureNativeReady(options, deps)).rejects.toMatchObject({ code: "NATIVE_STALE" });
  expect(refreshed).toBe(1);
  resetNativeReadinessForTests();
});

test("fixture plans outside the owner's state directory are not checked, and monitors need no plugin", async () => {
  resetNativeReadinessForTests();
  await ensureNativeReady({ planPath: "/fixture/host.json", controlDirectory: "/fixture/control" }, { diagnose: async () => { throw new Error("must not run"); } });
  const root = "/state";
  const options = { planPath: join(root, "current", "host.json"), controlDirectory: join(root, "control") };
  const notLoaded = { code: "PLUGIN_NOT_LOADED", blocking: true, message: "none loaded", fix: "Run: sbar-orbit native-refresh" };
  await ensureNativeReady(options, { root, requirePlugin: false, diagnose: async () => report({ problems: [notLoaded] }) });
  await expect(ensureNativeReady(options, { root, diagnose: async () => report({ problems: [notLoaded] }) })).rejects.toMatchObject({ code: "NATIVE_STALE" });
  resetNativeReadinessForTests();
});

test("doctor reports the live compositor even when the service environment is empty, and says what is missing", async () => {
  const keep = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP, DISPLAY: process.env.DISPLAY };
  delete process.env.WAYLAND_DISPLAY; delete process.env.XDG_CURRENT_DESKTOP; delete process.env.DISPLAY;
  try {
    const machine = await describeDesktopMachine(async () => report({ problems: [abiMismatch] }));
    expect(machine).toMatchObject({ sessionType: "wayland", desktop: "Hyprland", nativeDisplaySupported: false });
    expect((machine.native as { environmentMissingFromService: string[] }).environmentMissingFromService).toContain("WAYLAND_DISPLAY");
    expect((machine.notes as string[]).join(" ")).toContain("PLUGIN_ABI_MISMATCH");
    expect(await describeDesktopMachine(async () => report({ ready: true }))).toMatchObject({ nativeDisplaySupported: true });
  } finally {
    for (const [key, value] of Object.entries(keep)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("an adapter waits out a restarting broker but never retries a delivered request", async () => {
  const root = await scratch();
  const socket = join(root, "broker.sock");
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await expect(callPatient(socket, "doctor", {}, undefined, 60, async () => {})).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    setTimeout(() => { server = Bun.serve({ unix: socket, fetch: () => Response.json({ ok: true, result: { back: true } }) }); }, 300);
    expect(await callPatient(socket, "doctor", {}, undefined, 5000)).toEqual({ back: true });
    expect(brokerNotListening(new Error("boom"))).toBe(false);
    let attempts = 0;
    server?.stop(true);
    server = Bun.serve({ unix: socket + "2", fetch: () => { attempts++; return new Response("not json", { status: 500 }); } });
    await expect(callPatient(socket + "2", "doctor", {}, undefined, 2000)).rejects.toBeDefined();
    expect(attempts).toBe(1);
  } finally { server?.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);
