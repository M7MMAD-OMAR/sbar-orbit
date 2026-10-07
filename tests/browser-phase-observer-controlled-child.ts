import { expect, mock, test } from "bun:test";
import type { BrowserBackend as BrowserBackendType } from "../src/browser";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { CaptureRow } from "../src/browser-phase-observer";

const controlledFrame = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjKKKK/Sj5QKKKKACiiigAooooA//Z";
const controlledOwners = new Map<string, object>();
const controlledLaunchProfiles: string[] = [];
mock.module(fileURLToPath(import.meta.resolve("../src/chrome")), () => ({ launchChrome: async (profile: string) => { const owned = controlledOwners.get(profile); if (!owned) throw new Error("unowned controlled launch"); controlledLaunchProfiles.push(profile); return owned; } }));
const { beginBrowserCapture, registerBrowserPhases, classifyPipePhases } = await import("../src/browser-phase-observer");
const { BrowserBackend } = await import("../src/browser");
async function makeOwnedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orbit-phase-pure-"))); chmodSync(root, 0o700);
  const profile = join(root, "profile-owned"); mkdirSync(profile, { mode: 0o700 });
  let reads = 0, ready = false;
  const capture = { send: (_method: string, _args: object): unknown => Promise.resolve({ data: controlledFrame }), detach: async () => {} };
  const pointer = { on() {}, async send(method: string) { return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "owned-stub-pointer" } } } : {}; } };
  const attachmentCalls: object[] = [], closeListeners: (() => void)[] = [];
  const context: { setDefaultTimeout(): void; setDefaultNavigationTimeout(): void; on(): void; pages(): object[]; newCDPSession(page: object): Promise<typeof capture | typeof pointer> } = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {}, pages: () => [page], async newCDPSession(page: object) { if (ready) { attachmentCalls.push(page); return capture; } return pointer; } };
  const page = { isClosed: () => false, context() { reads++; return context; }, url: () => "about:blank", title: async () => "owned stub", on() {}, once() {} };
  const presence: Awaited<ReturnType<BrowserBackendType["observe"]>>["presence"] = { title: "owned stub", location: "New page", pageCount: 1, pageIndex: 1, tabs: [{ tab: 1, label: "owned stub", active: true }], pointer: null };
  const owned = { context, page, browser: {}, close: () => Promise.resolve(), onClose(listener: () => void) { closeListeners.push(listener); } };
  controlledOwners.set(profile, owned);
  const controlledLaunchCount = controlledLaunchProfiles.length;
  let acquiredBackend: BrowserBackendType | undefined;
  try {
    const backend = await BrowserBackend.create(profile);
    acquiredBackend = backend;
    expect(controlledLaunchProfiles.length).toBe(controlledLaunchCount + 1);
    expect(controlledLaunchProfiles[controlledLaunchCount]).toBe(profile);
    expect(Object.is(backend.context, context)).toBe(true);
    ready = true;
    return { backend, context, page, root, profile, capture, contextReads: () => reads, presence, attachmentCalls, owned, closeListeners, factorySetup() { ready = false; }, rows: [] as CaptureRow[], async dispose() { controlledOwners.delete(profile); await backend.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) {
    if (acquiredBackend) { try { await acquiredBackend.close(); } catch {} }
    controlledOwners.delete(profile);
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    throw error;
  }
}
async function fixture(work: (value: Awaited<ReturnType<typeof makeOwnedFixture>>) => void | Promise<void>) {
  const value = await makeOwnedFixture(); try { await work(value); } finally { await value.dispose(); }
}
test("unregistered backend is inert", () => { expect(beginBrowserCapture({}, {}, {}, 3000, false)).toBeUndefined(); });
test("unregistered backend performs no context query", () => { let called = false; expect(beginBrowserCapture({}, () => { called = true; return {}; }, {}, 3000, false)).toBeUndefined(); expect(called).toBe(false); });
test("foreign same-prefix profile refuses admission", () => fixture(v => {
  const foreign = `${v.root}-foreign`; mkdirSync(foreign, { mode: 0o700 }); const profile = join(foreign, "profile-other"); mkdirSync(profile, { mode: 0o700 });
  try { const admitted = registerBrowserPhases(v.backend, v.context, v.root, profile, row => v.rows.push(row)); try { expect(admitted).toBeUndefined(); } finally { admitted?.close(); } }
  finally { rmSync(foreign, { recursive: true, force: true }); }
}));
test("backend and context identities must both match", () => fixture(v => {
  expect(registerBrowserPhases(v.backend, {}, v.root, v.profile, () => {})).toBeUndefined();
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {});
  try { expect(reg).toBeDefined(); expect(beginBrowserCapture(v.backend, {}, v.page, 3000, false)).toBeUndefined(); expect(beginBrowserCapture({}, v.context, v.page, 3000, false)).toBeUndefined(); }
  finally { reg?.close(); }
}));
test("attachment settlement remains observable", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, row => v.rows.push(row));
  try { const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, false); expect(op).toBeDefined(); op?.mark("attachment-before"); op?.mark("attachment-settled"); op?.finish(); expect(v.rows.some(row => row.stage === "attachment-settled")).toBe(true); }
  finally { reg?.close(); }
}));
test("deadline distinguishes attachment pending from screenshot pending", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, row => v.rows.push(row));
  try { const first = beginBrowserCapture(v.backend, v.context, v.page, 3000, false); first?.mark("timer-fired"); first?.finish(); const second = beginBrowserCapture(v.backend, v.context, v.page, 3000, true); second?.mark("attachment-settled"); second?.mark("screenshot-before"); second?.mark("timer-fired"); second?.finish(); expect(v.rows.filter(row => row.stage === "timer-fired").map(row => row.pending)).toEqual(["attachment", "screenshot"]); }
  finally { reg?.close(); }
}));
test("late original settlement does not reopen registration", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, row => v.rows.push(row));
  const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, false); op?.mark("screenshot-before"); op?.mark("timer-fired"); reg?.close();
  expect(beginBrowserCapture(v.backend, v.context, v.page, 3000, false)).toBeUndefined(); op?.mark("screenshot-settled"); op?.finish();
  expect(v.rows.find(row => row.stage === "screenshot-settled")?.late).toBe(true); expect(reg?.snapshot().pending).toBe(0);
}));
/** Actual method only, through factory-created owned in-memory stubs, with no provider. */
async function actualFixture(work: (value: Awaited<ReturnType<typeof makeOwnedFixture>>) => Promise<void>) { await fixture(work); }
test("actual observe ordinary registration remains lazy", async () => actualFixture(async v => {
  const frame = await v.backend.observe();
  expect(frame.image).toBe(controlledFrame); expect(v.contextReads()).toBe(0); expect(v.attachmentCalls.length).toBe(1);
}));
test("actual observe preserves CDP receiver arguments and original await", async () => actualFixture(async v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {});
  let receiver: unknown, method: unknown, args: unknown, awaits = 0;
  v.capture.send = function (name, input) { receiver = this; method = name; args = input; return { then(resolve: (value: { data: string }) => void) { awaits++; resolve({ data: controlledFrame }); } }; };
  try {
    expect(reg).toBeDefined(); const frame = await v.backend.observe();
    expect(receiver).toBe(v.capture); expect(method).toBe("Page.captureScreenshot");
    expect(args).toEqual({ format: "jpeg", quality: 80, fromSurface: true, captureBeyondViewport: false });
    expect(awaits).toBe(1); expect(frame.image).toBe(controlledFrame); expect(frame.presence).toEqual(v.presence); expect({ width: frame.width, height: frame.height }).toEqual({ width: 32, height: 24 });
    expect(v.contextReads()).toBe(1); expect(reg?.snapshot().pending).toBe(0);
    expect(reg?.snapshot().rows.map(row => row.stage)).toEqual(["begin", "attachment-before", "attachment-settled", "screenshot-before", "screenshot-settled", "presence-before", "presence-settled", "race-settled", "cleanup"]);
  } finally { reg?.close(); }
}));
test("actual observe preserves screenshot rejection object identity", async () => actualFixture(async v => {
  const original = new Error("owned original screenshot rejection");
  v.capture.send = () => Promise.reject(original);
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => { throw new Error("owned throwing sink"); });
  try {
    expect(reg).toBeDefined(); let caught: unknown;
    try { await v.backend.observe(); } catch (error) { caught = error; }
    expect(caught).toBe(original); expect(reg?.snapshot().pending).toBe(0); expect(reg?.snapshot().sinkFailures).toBeGreaterThan(0);
    expect(reg?.snapshot().rows.some(row => row.stage === "screenshot-rejected")).toBe(true);
  } finally { reg?.close(); }
}));
test("throwing sink marks evidence incomplete without throwing", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => { throw new Error("owned sink failure"); });
  try { const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, false); expect(() => op?.mark("cleanup")).not.toThrow(); op?.finish(); expect(reg?.snapshot().complete).toBe(false); expect(reg?.snapshot().sinkFailures).toBeGreaterThan(0); }
  finally { reg?.close(); }
}));
test("overflow retains bounded records and explicit incompleteness", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {});
  try { const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, false); for (let n = 0; n < 200; n++) op?.mark("cleanup"); op?.finish(); expect(reg?.snapshot().rows.length).toBe(128); expect(reg?.snapshot().dropped).toBeGreaterThan(0); expect(reg?.snapshot().complete).toBe(false); }
  finally { reg?.close(); }
}));
test("pending operation is not promoted to completed cleanup", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {}); const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, false); reg?.close();
  expect(reg?.snapshot().pending).toBe(1); expect(reg?.snapshot().complete).toBe(false); op?.finish();
}));
test("fixed rows omit private paths and arbitrary error data", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, row => v.rows.push(row));
  try { reg?.label("permitted-frame"); const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, false); op?.mark("attachment-rejected"); op?.finish(); const text = JSON.stringify(v.rows); expect(text.includes(v.root)).toBe(false); expect(text.includes(v.profile)).toBe(false); expect(v.rows[0]?.label).toBe("permitted-frame"); }
  finally { reg?.close(); }
}));
test("absent and partial pipe evidence preserves original nonzero exit", () => {
  expect(classifyPipePhases(undefined, 143)).toMatchObject({ exit: 143, complete: false, status: "not measured" });
  expect(classifyPipePhases('{"phase":"spawned","monotonicNs":1}\n', 143)).toMatchObject({ exit: 143, complete: false });
  expect(classifyPipePhases('{"phase":', 0)).toMatchObject({ exit: 0, complete: false, status: "not measured" });
});
test("private or foreign pipe fields invalidate sidecar", () => { expect(classifyPipePhases('{"phase":"spawned","monotonicNs":1,"url":"private"}\n', 0)).toMatchObject({ complete: false, status: "not measured", rows: [] }); });

test("recent late timeout survives many successful captures", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {});
  for (let n = 0; n < 100; n++) { const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, true); op?.mark("attachment-settled"); op?.mark("screenshot-before"); op?.mark("screenshot-settled"); op?.finish(); }
  const op = beginBrowserCapture(v.backend, v.context, v.page, 3000, true); op?.mark("screenshot-before"); op?.mark("timer-fired"); reg?.close(); op?.mark("screenshot-settled"); op?.finish();
  const snapshot = reg?.snapshot(); expect(snapshot?.rows.length).toBe(128);
  expect(snapshot?.rows.slice(0, 32).map(row => row.sequence)).toEqual(Array.from({ length: 32 }, (_, n) => n + 1));
  expect(snapshot?.rows.slice(32).map(row => row.sequence)).toEqual(Array.from({ length: 96 }, (_, n) => n + 309));
  expect(snapshot?.dropped).toBe(276); expect(snapshot?.retention).toEqual({ first: 32, recent: 96, emitted: 404, firstDropped: 33, lastDropped: 308 });
  expect(snapshot?.rows.find(row => row.stage === "timer-fired")).toMatchObject({ pending: "screenshot", expired: true, sequence: 403 });
  expect(snapshot?.rows.at(-1)).toMatchObject({ stage: "screenshot-settled", late: true, sequence: 404 }); expect(snapshot?.pending).toBe(0); expect(snapshot?.complete).toBe(false);
}));
const successStages = ["entered", "spawned", "delay-complete", "communicate-before", "communicate-settled", "output-write-before", "output-write-settled"];
const transcript = (stages: string[], clocks = stages.map((_, n) => n)) => stages.map((phase, n) => JSON.stringify({ phase, monotonicNs: clocks[n] })).join("\n");
test("complete pipe evidence requires all seven ordered success stages", () => {
  expect(classifyPipePhases(transcript(successStages), 0).complete).toBe(true);
  expect(classifyPipePhases(transcript(successStages, [1, 1, 2, 2, 3, 3, 4]), 0).complete).toBe(true);
  expect(classifyPipePhases(transcript(successStages), 143).complete).toBe(false);
});
test("missing earlier or last pipe stage remains partial", () => {
  for (const stages of [successStages.slice(0, -1), successStages.slice(1), ["output-write-settled"]]) {
    const result = classifyPipePhases(transcript(stages), 0); expect(result.complete).toBe(false); expect(result.rows.map(row => row.phase)).toEqual(stages);
  }
});
test("wrong order duplicate and contradictory clocks cannot complete pipe evidence", () => {
  const wrong = [...successStages]; [wrong[1], wrong[2]] = ["delay-complete", "spawned"];
  for (const text of [transcript(wrong), transcript([...successStages, "output-write-settled"]), transcript(successStages, [0, 1, 2, 1, 4, 5, 6])]) {
    expect(classifyPipePhases(text, 0).complete).toBe(false); expect(classifyPipePhases(text, 0).rows.length).toBeGreaterThan(0);
  }
});

test("factory provenance admits the exact created profile", async () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {}); try { expect(reg).toBeDefined(); } finally { reg?.close(); }
}));
test("sibling profile refuses factory provenance", async () => fixture(v => {
  const sibling = join(v.root, "profile-sibling"); mkdirSync(sibling, { mode: 0o700 });
  const reg = registerBrowserPhases(v.backend, v.context, v.root, sibling, () => {}); try { expect(reg).toBeUndefined(); } finally { reg?.close(); }
}));
test("unrelated workspace refuses factory provenance", async () => fixture(v => {
  const root = mkdtempSync(join(tmpdir(), "orbit-phase-other-")); chmodSync(root, 0o700); const profile = join(root, "profile-other"); mkdirSync(profile, { mode: 0o700 });
  try { const reg = registerBrowserPhases(v.backend, v.context, root, profile, () => {}); try { expect(reg).toBeUndefined(); } finally { reg?.close(); } } finally { rmSync(root, { recursive: true, force: true }); }
}));
test("direct construction cannot mint factory provenance", async () => fixture(v => {
  const forged = Reflect.construct(BrowserBackend, [v.owned, v.context, v.page, { width: 32, height: 24 }]);
  const reg = registerBrowserPhases(forged, v.context, v.root, v.profile, () => {}); try { expect(reg).toBeUndefined(); } finally { reg?.close(); }
}));
test("context profile spoof cannot replace factory provenance", async () => fixture(v => {
  const sibling = join(v.root, "profile-spoof"); mkdirSync(sibling, { mode: 0o700 }); Object.assign(v.context, { profile: sibling });
  const reg = registerBrowserPhases(v.backend, v.context, v.root, sibling, () => {}); try { expect(reg).toBeUndefined(); } finally { reg?.close(); }
}));
test("close request revokes before original promise settles", async () => fixture(v => {
  let settle: (() => void) | undefined; const original = new Promise<void>(resolve => { settle = resolve; }); v.owned.close = () => original;
  const returned = v.backend.close(); const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {});
  try { expect(returned).toBe(original); expect(reg).toBeUndefined(); } finally { reg?.close(); settle?.(); }
}));
test("close preserves original rejected promise and error", async () => fixture(async v => {
  const error = new Error("owned close rejection"); const original = Promise.reject(error); v.owned.close = () => original;
  const returned = v.backend.close(); expect(returned).toBe(original); let caught: unknown; try { await returned; } catch (value) { caught = value; } expect(caught).toBe(error);
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {}); try { expect(reg).toBeUndefined(); } finally { reg?.close(); }
}));
test("owned close callback revokes without backend close request", async () => fixture(v => {
  for (const listener of v.closeListeners) listener();
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, () => {}); try { expect(reg).toBeUndefined(); } finally { reg?.close(); }
}));
test("already closed immediate callback cannot leave factory provenance", async () => fixture(async v => {
  v.owned.onClose = listener => { listener(); }; v.factorySetup(); const closed = await BrowserBackend.create(v.profile);
  const reg = registerBrowserPhases(closed, v.context, v.root, v.profile, () => {}); try { expect(reg).toBeUndefined(); } finally { reg?.close(); await closed.close(); }
}));


/** Existing registration lifetime controls, in-memory factory launcher only. */
test("still live registration admits new capture and settlement", () => fixture(v => {
  const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, row => v.rows.push(row));
  try {
    expect(reg).toBeDefined();
    const reads = v.contextReads();
    const op = beginBrowserCapture(v.backend, () => v.page.context(), v.page, 3000, false);
    expect(op).toBeDefined(); expect(v.contextReads()).toBe(reads + 1);
    op?.mark("screenshot-before"); op?.mark("screenshot-settled"); op?.finish();
    expect(v.rows.map(row => row.stage)).toEqual(["begin", "screenshot-before", "screenshot-settled"]);
    expect(v.rows.every(row => row.late === false)).toBe(true);
    expect(reg?.snapshot().pending).toBe(0);
    console.error(JSON.stringify({ registrationLifetime: { path: "still-live", admitted: op !== undefined, contextQueryDelta: v.contextReads() - reads, stages: v.rows.map(row => row.stage), pending: reg?.snapshot().pending } }));
  } finally { reg?.close(); }
}));
for (const path of ["close-request", "owned-callback"] as const) {
  test(`existing registration refuses new capture after ${path}`, () => fixture(v => {
    const reg = registerBrowserPhases(v.backend, v.context, v.root, v.profile, row => v.rows.push(row));
    let settle: (() => void) | undefined;
    try {
      expect(reg).toBeDefined();
      const admitted = beginBrowserCapture(v.backend, () => v.page.context(), v.page, 3000, false);
      expect(admitted).toBeDefined(); admitted?.mark("screenshot-before");
      expect(reg?.snapshot().pending).toBe(1);
      if (path === "close-request") {
        const original = new Promise<void>(resolve => { settle = resolve; });
        let receiver: unknown;
        v.owned.close = function() { receiver = this; return original; };
        const returned = v.backend.close();
        expect(returned).toBe(original); expect(receiver).toBe(v.owned);
      } else {
        expect(v.closeListeners.length).toBe(1);
        for (const listener of v.closeListeners) listener();
      }
      const reads = v.contextReads(), rows = v.rows.length;
      const refused = beginBrowserCapture(v.backend, () => v.page.context(), v.page, 3000, false);
      refused?.finish();
      admitted?.mark("screenshot-settled"); admitted?.finish();
      const settlement = v.rows.find(row => row.stage === "screenshot-settled");
      console.error(JSON.stringify({ registrationLifetime: { path, admittedBeforeRevocation: admitted !== undefined, admittedAfterRevocation: refused !== undefined, contextQueryDelta: v.contextReads() - reads, newBeginRows: v.rows.slice(rows).filter(row => row.stage === "begin").length, settlementRecorded: settlement !== undefined, settlementOperation: settlement?.operation, settlementLate: settlement?.late, pending: reg?.snapshot().pending } }));
      expect(v.contextReads()).toBe(reads);
      expect(refused).toBeUndefined();
      expect(v.rows.slice(rows).filter(row => row.stage === "begin")).toEqual([]);
      expect(settlement?.operation).toBe(1); expect(settlement?.late).toBe(true);
      expect(reg?.snapshot().pending).toBe(0);
    } finally { reg?.close(); settle?.(); }
  }));
}
