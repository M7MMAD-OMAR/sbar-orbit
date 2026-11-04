import { expect, spyOn, test } from "bun:test";
import { ReadBudgetError, ReadResourceBudget, READ_BUDGET_LIMITS } from "../src/multi-view-read-budget";

// Pure ledger fixtures, not allocator, RSS, process-drain or OS proofs.
const request = { scratchBytes: 7, retainedBytes: 3 };
const empty = { views: 0, conversations: 0, entries: 0, bytes: 0, quarantined: 0, retainedReferences: 0 };
const refuses = (code: ReadBudgetError["code"], action: () => unknown) => {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ReadBudgetError);
  if (!(caught instanceof ReadBudgetError)) throw new Error("Expected budget refusal");
  expect(caught.code).toBe(code);
};
const unchanged = (budget: ReadResourceBudget, code: ReadBudgetError["code"], action: () => unknown) => {
  const before = budget.status();
  refuses(code, action);
  expect(budget.status()).toEqual(before);
};

test("construction is dormant and default caps are exact", () => {
  expect(READ_BUDGET_LIMITS).toEqual({
    deviceBytes: 32 * 1024 * 1024, viewBytes: 16 * 1024 * 1024,
    maxViews: 8, maxConversations: 4, maxViewsPerConversation: 2,
    maxEntriesPerView: 2, maxReferences: 32,
  });
  const timeout = spyOn(globalThis, "setTimeout"), interval = spyOn(globalThis, "setInterval");
  try {
    const budget = new ReadResourceBudget();
    expect(budget.status()).toMatchObject(empty);
    expect(budget.status().captureOccupied).toBe(false);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally { timeout.mockRestore(); interval.mockRestore(); }
});

test("constructor permits only stricter positive safe integer overrides and copies options", () => {
  for (const key of Object.keys(READ_BUDGET_LIMITS) as (keyof typeof READ_BUDGET_LIMITS)[]) {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, READ_BUDGET_LIMITS[key] + 1, "1", null]) {
      refuses("INVALID", () => new ReadResourceBudget({ [key]: value } as never));
    }
    expect(new ReadResourceBudget(key === "deviceBytes" ? { deviceBytes: 1, viewBytes: 1 } : { [key]: 1 }).status()).toMatchObject(empty);
  }
  const options = { deviceBytes: 10, viewBytes: 10, maxViews: 1 };
  const budget = new ReadResourceBudget(options);
  options.deviceBytes = 100; options.viewBytes = 100; options.maxViews = 8;
  const view = budget.bindView({});
  unchanged(budget, "LIMIT", () => budget.reserve(view, { scratchBytes: 8, retainedBytes: 3 }));
  unchanged(budget, "LIMIT", () => budget.bindView({}));
});

test("runtime rebinding or shadowing public limits cannot relax private accounting caps", () => {
  const budget = new ReadResourceBudget({ deviceBytes: 10, viewBytes: 10, maxViews: 1, maxReferences: 1 });
  const original = budget.limits;
  expect(Object.isFrozen(original)).toBe(true);
  expect(Reflect.set(original, "deviceBytes", Number.MAX_SAFE_INTEGER)).toBe(false);
  expect(Reflect.set(budget, "limits", { ...READ_BUDGET_LIMITS })).toBe(false);
  // Even an own-property shadow of the getter cannot replace the private enforcement snapshot.
  Object.defineProperty(budget, "limits", { value: { ...READ_BUDGET_LIMITS }, configurable: true });
  expect(budget.limits.deviceBytes).toBe(READ_BUDGET_LIMITS.deviceBytes);
  const view = budget.bindView({});
  unchanged(budget, "LIMIT", () => budget.bindView({}));
  unchanged(budget, "LIMIT", () => budget.reserve(view, { scratchBytes: 8, retainedBytes: 3 }));
  const reservation = budget.reserve(view, request);
  budget.start(reservation).confirmStopped(true);
  unchanged(budget, "LIMIT", () => budget.retain(reservation));
  budget.release(reservation);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, retainedReferences: 0 });
});

test("constructor and cost descriptors reject accessor symbol and nonplain data", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "maxViews", { enumerable: true, get() { reads++; return 1; } });
  refuses("INVALID", () => new ReadResourceBudget(accessor));
  expect(reads).toBe(0);
  const symbol = Symbol("not-a-limit");
  for (const options of [{ [symbol]: 1 }, Object.create({ maxViews: 1 }), [], { unknown: 1 }]) {
    refuses("INVALID", () => new ReadResourceBudget(options as never));
  }
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  for (const cost of [{ ...request, [symbol]: 1 }, Object.create(request), []]) {
    unchanged(budget, "INVALID", () => budget.reserve(view, cost as never));
  }
});

test("reentrant proxy cost inspection cannot bypass view revocation or occupied capture credit", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const revokedCost = new Proxy(request, { ownKeys(target) { budget.revokeView(view); return Reflect.ownKeys(target); } });
  refuses("REVOKED", () => budget.reserve(view, revokedCost));
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, captureOccupied: false });
  const fresh = budget.bindView({}), other = budget.bindView({});
  let replacement: ReturnType<ReadResourceBudget["reserve"]> | undefined;
  const competingCost = new Proxy(request, { ownKeys(target) {
    replacement ??= budget.reserve(other, request); return Reflect.ownKeys(target);
  } });
  refuses("BUSY", () => budget.reserve(fresh, competingCost));
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 10, captureOccupied: true });
  budget.cancel(replacement!);
});

test("view and conversation capacities recover only after revoked empty views are disposed", () => {
  const budget = new ReadResourceBudget();
  const conversations = Array.from({ length: 4 }, () => ({}));
  const views = conversations.flatMap(conversation => [budget.bindView(conversation), budget.bindView(conversation)]);
  expect(budget.status()).toMatchObject({ ...empty, views: 8, conversations: 4 });
  unchanged(budget, "LIMIT", () => budget.bindView(conversations[0]!));
  unchanged(budget, "LIMIT", () => budget.bindView({}));
  const view = views[0]!;
  unchanged(budget, "STATE", () => budget.disposeView(view));
  budget.revokeView(view);
  expect(budget.status().views).toBe(8);
  unchanged(budget, "REVOKED", () => budget.reserve(view, request));
  budget.disposeView(view);
  expect(budget.status()).toMatchObject({ views: 7, conversations: 4 });
  budget.revokeView(views[1]!); budget.disposeView(views[1]!);
  expect(budget.status()).toMatchObject({ views: 6, conversations: 3 });
  budget.bindView({});
  expect(budget.status()).toMatchObject({ views: 7, conversations: 4 });
});

test("stricter independent conversation and per-conversation limits are enforced", () => {
  const budget = new ReadResourceBudget({ maxConversations: 1 }), owner = {};
  budget.bindView(owner);
  unchanged(budget, "LIMIT", () => budget.bindView({}));
  budget.bindView(owner);
  const single = new ReadResourceBudget({ maxViewsPerConversation: 1 });
  single.bindView(owner);
  unchanged(single, "LIMIT", () => single.bindView(owner));
  single.bindView({});
});

test("reservation charges peak bytes and global capture slot before start", () => {
  const budget = new ReadResourceBudget({ deviceBytes: 15, viewBytes: 10 });
  const view = budget.bindView({}), other = budget.bindView({});
  const reservation = budget.reserve(view, request);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(reservation)).toBe(true);
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 10, retainedReferences: 0 });
  expect(budget.status().captureOccupied).toBe(true);
  unchanged(budget, "BUSY", () => budget.reserve(other, { scratchBytes: 1, retainedBytes: 1 }));
  const operation = budget.start(reservation);
  expect(Object.isFrozen(operation)).toBe(true);
  expect(budget.inspect(reservation)).toMatchObject({ phase: "running", bytes: 10, references: 0 });
  expect(operation.confirmStopped(true)).toBe(true);
  expect(budget.inspect(reservation)).toMatchObject({ phase: "retained", bytes: 3, references: 1, deliverable: true });
  expect(budget.isDeliverable(reservation)).toBe(true);
  expect(budget.status().captureOccupied).toBe(false);
  unchanged(budget, "LIMIT", () => budget.reserve(view, { scratchBytes: 6, retainedBytes: 2 }));
  const next = budget.reserve(other, { scratchBytes: 9, retainedBytes: 1 });
  budget.cancel(next);
  unchanged(budget, "LIMIT", () => budget.reserve(other, { scratchBytes: 10, retainedBytes: 3 }));
  budget.release(reservation);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, retainedReferences: 0 });
});

test("costs reject accessors without invoking them and snapshot caller-owned data", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  let reads = 0;
  const accessor = {
    get scratchBytes() { reads++; return reads === 1 ? 1 : Number.MAX_SAFE_INTEGER; },
    retainedBytes: 3,
  };
  unchanged(budget, "INVALID", () => budget.reserve(view, accessor));
  expect(reads).toBe(0);
  const inherited = Object.create({ scratchBytes: 7, retainedBytes: 3 });
  unchanged(budget, "INVALID", () => budget.reserve(view, inherited));
  const cost = { ...request };
  const reservation = budget.reserve(view, cost);
  cost.scratchBytes = 1000; cost.retainedBytes = 1000;
  const operation = budget.start(reservation);
  expect(budget.inspect(reservation).bytes).toBe(10);
  operation.confirmStopped(true);
  expect(budget.inspect(reservation)).toMatchObject({ bytes: 3, references: 1 });
  budget.release(reservation);
  expect(budget.status()).toMatchObject({ bytes: 0, entries: 0 });
});

test("device total includes retained results from other views", () => {
  const budget = new ReadResourceBudget({ deviceBytes: 15, viewBytes: 10 });
  const owner = {}, firstView = budget.bindView(owner), secondView = budget.bindView(owner);
  const thirdView = budget.bindView({});
  const first = budget.reserve(firstView, { scratchBytes: 0, retainedBytes: 6 });
  budget.start(first).confirmStopped(true);
  const second = budget.reserve(secondView, { scratchBytes: 0, retainedBytes: 6 });
  budget.start(second).confirmStopped(true);
  expect(budget.status()).toMatchObject({ entries: 2, bytes: 12, captureOccupied: false });
  unchanged(budget, "LIMIT", () => budget.reserve(thirdView, { scratchBytes: 3, retainedBytes: 1 }));
  const exact = budget.reserve(thirdView, { scratchBytes: 2, retainedBytes: 1 });
  expect(budget.status().bytes).toBe(15);
  budget.cancel(exact); budget.release(first); budget.release(second);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, retainedReferences: 0 });
});

test("default reference ceiling is exactly 32 and snapshots cannot mutate counters", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const reservation = budget.reserve(view, request), operation = budget.start(reservation);
  operation.confirmStopped(true);
  for (let i = 1; i < 32; i++) budget.retain(reservation);
  expect(budget.status().retainedReferences).toBe(32);
  unchanged(budget, "LIMIT", () => budget.retain(reservation));
  const snapshot = budget.status(), entry = budget.inspect(reservation);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(entry)).toBe(true);
  expect(Reflect.set(snapshot, "bytes", -1)).toBe(false);
  expect(Reflect.set(entry, "references", 0)).toBe(false);
  expect(operation.confirmStopped(true)).toBe(false);
  expect(operation.unknownDrain()).toBe(false);
  expect(budget.status()).toEqual(snapshot);
  for (let i = 0; i < 32; i++) budget.release(reservation);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, retainedReferences: 0 });
  expect("forceRelease" in budget).toBe(false);
});

test("invalid bytes never consume accounting credit", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  for (const cost of [{ scratchBytes: 0, retainedBytes: 0 }, { scratchBytes: Number.MAX_SAFE_INTEGER, retainedBytes: 1 }, {}, { ...request, extra: 1 }]) {
    unchanged(budget, "INVALID", () => budget.reserve(view, cost as never));
  }
  for (const key of ["scratchBytes", "retainedBytes"] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      unchanged(budget, "INVALID", () => budget.reserve(view, { ...request, [key]: value } as never));
    }
  }
});

test("zero retained bytes cannot publish or prematurely free capture slot", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const reservation = budget.reserve(view, { scratchBytes: 1, retainedBytes: 0 });
  const operation = budget.start(reservation);
  refuses("STATE", () => operation.confirmStopped(true));
  expect(budget.inspect(reservation)).toMatchObject({ phase: "quarantined", bytes: 1, deliverable: false });
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 1, quarantined: 1 });
  expect(budget.status().captureOccupied).toBe(true);
  expect(budget.isDeliverable(reservation)).toBe(false);
  expect(operation.confirmStopped()).toBe(true);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0 });
  expect(operation.confirmStopped(true)).toBe(false);
  expect(operation.unknownDrain()).toBe(false);
});

test("cancel frees reserved credit but started work waits for trusted stop", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const pending = budget.reserve(view, request);
  budget.cancel(pending);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0 });
  const running = budget.reserve(view, request), operation = budget.start(running);
  budget.cancel(running);
  expect(budget.inspect(running)).toMatchObject({ phase: "cancel_pending", bytes: 10, deliverable: false });
  expect(budget.status().captureOccupied).toBe(true);
  unchanged(budget, "BUSY", () => budget.reserve(view, request));
  unchanged(budget, "STATE", () => budget.release(running));
  expect(operation.confirmStopped(true)).toBe(true);
  expect(budget.isDeliverable(running)).toBe(false);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, retainedReferences: 0 });
  const replacement = budget.reserve(view, request);
  expect(operation.confirmStopped(true)).toBe(false);
  expect(operation.unknownDrain()).toBe(false);
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 10 });
  expect(budget.status().captureOccupied).toBe(true);
  budget.cancel(replacement);
});

for (const cancelFirst of [false, true]) test("unknown drain retains all credit, cancel first=" + cancelFirst, () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const reservation = budget.reserve(view, request), operation = budget.start(reservation);
  if (cancelFirst) budget.cancel(reservation);
  expect(operation.unknownDrain()).toBe(true);
  expect(budget.inspect(reservation)).toMatchObject({ phase: "quarantined", bytes: 10, references: 0, deliverable: false });
  expect(budget.status()).toMatchObject({ entries: 1, bytes: 10, quarantined: 1 });
  expect(budget.status().captureOccupied).toBe(true);
  unchanged(budget, "BUSY", () => budget.reserve(view, request));
  unchanged(budget, "STATE", () => budget.release(reservation));
  budget.revokeView(view);
  unchanged(budget, "STATE", () => budget.disposeView(view));
  expect(operation.confirmStopped(true)).toBe(true);
  expect(budget.isDeliverable(reservation)).toBe(false);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, quarantined: 0 });
  expect(operation.confirmStopped()).toBe(false);
  expect(operation.unknownDrain()).toBe(false);
  budget.disposeView(view);
  expect(budget.status()).toMatchObject(empty);
});

test("quarantine alone blocks late publication and stale callbacks cannot free a new capture", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const first = budget.reserve(view, request), operation = budget.start(first);
  expect(operation.unknownDrain()).toBe(true);
  const occupied = budget.status();
  expect(operation.unknownDrain()).toBe(false);
  expect(budget.status()).toEqual(occupied);
  expect(operation.confirmStopped(true)).toBe(true);
  expect(budget.isDeliverable(first)).toBe(false);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, retainedReferences: 0, quarantined: 0 });
  const replacement = budget.reserve(view, request), beforeLateCallback = budget.status();
  expect(operation.confirmStopped()).toBe(false);
  expect(operation.unknownDrain()).toBe(false);
  expect(budget.status()).toEqual(beforeLateCallback);
  expect(budget.status().captureOccupied).toBe(true);
  budget.cancel(replacement);
});

test("revocation suppresses delivery without releasing externally held result references", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const reservation = budget.reserve(view, request), operation = budget.start(reservation);
  operation.confirmStopped(true); budget.retain(reservation);
  expect(budget.status()).toMatchObject({ bytes: 3, retainedReferences: 2, entries: 1 });
  budget.revokeView(view);
  expect(budget.isDeliverable(reservation)).toBe(false);
  unchanged(budget, "STATE", () => budget.retain(reservation));
  expect(budget.inspect(reservation)).toMatchObject({ references: 2, bytes: 3, deliverable: false });
  unchanged(budget, "STATE", () => budget.disposeView(view));
  budget.release(reservation);
  expect(budget.status()).toMatchObject({ bytes: 3, retainedReferences: 1 });
  budget.release(reservation);
  expect(budget.status()).toMatchObject({ bytes: 0, retainedReferences: 0, entries: 0 });
  budget.disposeView(view);
  expect(budget.status()).toMatchObject(empty);
});

test("revocation cancels reserved work and holds started work until stopped", () => {
  for (const started of [false, true]) {
    const budget = new ReadResourceBudget(), view = budget.bindView({});
    const reservation = budget.reserve(view, request);
    const operation = started ? budget.start(reservation) : undefined;
    budget.revokeView(view);
    expect(budget.isDeliverable(reservation)).toBe(false);
    expect(budget.status()).toMatchObject({ entries: started ? 1 : 0, bytes: started ? 10 : 0 });
    if (operation) {
      expect(budget.inspect(reservation).phase).toBe("cancel_pending");
      unchanged(budget, "STATE", () => budget.disposeView(view));
      operation.confirmStopped(true);
    }
    budget.disposeView(view);
    expect(budget.status()).toMatchObject(empty);
  }
});

test("entry and reference limits count retained results, not just captures", () => {
  const budget = new ReadResourceBudget({ maxReferences: 2 }), view = budget.bindView({});
  const first = budget.reserve(view, request);
  budget.start(first).confirmStopped(true); budget.retain(first);
  unchanged(budget, "LIMIT", () => budget.retain(first));
  budget.release(first);
  const second = budget.reserve(view, request);
  budget.start(second).confirmStopped(true);
  expect(budget.status()).toMatchObject({ entries: 2, bytes: 6, retainedReferences: 2 });
  unchanged(budget, "LIMIT", () => budget.reserve(view, request));
  budget.release(first); budget.release(second);
  expect(budget.status()).toMatchObject({ entries: 0, bytes: 0, retainedReferences: 0 });
  const single = new ReadResourceBudget({ maxEntriesPerView: 1 }), singleView = single.bindView({});
  const retained = single.reserve(singleView, request);
  single.start(retained).confirmStopped(true);
  unchanged(single, "LIMIT", () => single.reserve(singleView, request));
});

test("forged cloned foreign and stale handles cannot consume or recover credit", () => {
  const budget = new ReadResourceBudget(), view = budget.bindView({});
  const reservation = budget.reserve(view, request);
  const foreign = new ReadResourceBudget(), foreignView = foreign.bindView({});
  const foreignReservation = foreign.reserve(foreignView, request);
  for (const handle of [{}, { ...reservation }, foreignReservation, view]) {
    expect(budget.isDeliverable(handle as never)).toBe(false);
    for (const action of [
      () => budget.inspect(handle as never), () => budget.start(handle as never),
      () => budget.cancel(handle as never), () => budget.retain(handle as never), () => budget.release(handle as never),
    ]) unchanged(budget, "HANDLE", action);
  }
  for (const handle of [{}, { ...view }, foreignView, reservation]) {
    unchanged(budget, "HANDLE", () => budget.reserve(handle as never, request));
    unchanged(budget, "HANDLE", () => budget.revokeView(handle as never));
    unchanged(budget, "HANDLE", () => budget.disposeView(handle as never));
  }
  unchanged(budget, "STATE", () => budget.retain(reservation));
  unchanged(budget, "STATE", () => budget.release(reservation));
  const operation = budget.start(reservation);
  unchanged(budget, "STATE", () => budget.start(reservation));
  operation.confirmStopped(true); budget.release(reservation);
  expect(budget.isDeliverable(reservation)).toBe(false);
  unchanged(budget, "HANDLE", () => budget.release(reservation));
  unchanged(budget, "HANDLE", () => budget.inspect(reservation));
  unchanged(budget, "HANDLE", () => budget.start(reservation));
  expect(operation.confirmStopped(true)).toBe(false);
  budget.revokeView(view); budget.disposeView(view);
  unchanged(budget, "HANDLE", () => budget.reserve(view, request));
  expect(budget.status()).toMatchObject(empty);
});

test("deterministic mixed lifecycle sequences conserve every byte reference and capture slot", () => {
  const budget = new ReadResourceBudget(), conversation = {};
  const views = [budget.bindView(conversation), budget.bindView(conversation), budget.bindView({})];
  const history: { handle: ReturnType<ReadResourceBudget["reserve"]>; operation?: ReturnType<ReadResourceBudget["start"]> }[] = [];
  let seed = 0x4aaf6cc0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  // Seed real publication/ref/cancel/quarantine transitions, then vary timing and handles.
  const prefix = [0, 1, 4, 6, 7, 2, 7, 0, 1, 2, 3, 4, 0, 2, 0, 1, 3, 5];
  const selected = Array<number>(8).fill(0), successful = Array<number>(8).fill(0), phases = new Set<string>();
  const liveEntries = () => history.flatMap(item => {
    try { return [{ item, state: budget.inspect(item.handle) }]; } catch (error) {
      if (!(error instanceof ReadBudgetError) || error.code !== "HANDLE") throw error;
      return [];
    }
  });
  for (let step = 0; step < 1000; step++) {
    const action = prefix[step] ?? ((random() >>> 24) % 8);
    selected[action] = selected[action]! + 1;
    try {
      let changed = true;
      if (action === 0) {
        const scratchBytes = random() % 32, retainedBytes = 1 + random() % 32;
        history.push({ handle: budget.reserve(views[random() % views.length]!, { scratchBytes, retainedBytes }) });
      } else {
        const before = liveEntries();
        const preferred = before.filter(entry => action === 1 ? entry.state.phase === "reserved"
          : action === 2 ? entry.state.phase === "running" || entry.state.phase === "reserved"
          : action === 3 ? entry.state.phase === "running" || entry.state.phase === "cancel_pending"
          : action === 4 ? entry.state.phase === "running"
          : action === 5 ? entry.state.phase === "quarantined" || entry.state.phase === "cancel_pending"
          : action === 6 ? entry.state.deliverable : entry.state.phase === "retained");
        const pool = step >= prefix.length && random() % 7 === 0 ? history
          : (preferred.length ? preferred : before).map(entry => entry.item);
        const item = pool[random() % pool.length] ?? history[random() % history.length]!;
        if (action === 1) item.operation = budget.start(item.handle);
        else if (action === 2) changed = budget.cancel(item.handle);
        else if (action === 3) changed = item.operation?.unknownDrain() ?? false;
        else if (action === 4) changed = item.operation?.confirmStopped(true) ?? false;
        else if (action === 5) changed = item.operation?.confirmStopped(false) ?? false;
        else if (action === 6) budget.retain(item.handle);
        else budget.release(item.handle);
      }
      if (changed) successful[action] = successful[action]! + 1;
    } catch (error) { expect(error).toBeInstanceOf(ReadBudgetError); }
    const live = liveEntries();
    for (const entry of live) phases.add(entry.state.phase);
    const status = budget.status();
    expect(status.bytes).toBe(live.reduce((sum, entry) => sum + entry.state.bytes, 0));
    expect(status.entries).toBe(live.length);
    expect(status.retainedReferences).toBe(live.reduce((sum, entry) => sum + entry.state.references, 0));
    expect(status.quarantined).toBe(live.filter(entry => entry.state.phase === "quarantined").length);
    const occupied = live.filter(entry => entry.state.phase !== "retained");
    expect(occupied.length).toBeLessThanOrEqual(1);
    expect(status.captureOccupied).toBe(occupied.length === 1);
    expect(status.bytes).toBeGreaterThanOrEqual(0);
    expect(status.bytes).toBeLessThanOrEqual(budget.limits.deviceBytes);
  }
  expect(selected.every(count => count > 0)).toBe(true);
  expect(successful.every(count => count > 0)).toBe(true);
  expect([...phases].sort()).toEqual(["cancel_pending", "quarantined", "reserved", "retained", "running"]);
  for (const item of history) {
    if (!budget.isDeliverable(item.handle)) {
      try {
        const state = budget.inspect(item.handle);
        if (state.phase === "reserved") budget.cancel(item.handle);
        else if (state.phase !== "retained") item.operation!.confirmStopped(false);
        else for (let count = 0; count < state.references; count++) budget.release(item.handle);
      } catch (error) { expect(error).toMatchObject({ code: "HANDLE" }); }
    } else {
      const references = budget.inspect(item.handle).references;
      for (let count = 0; count < references; count++) budget.release(item.handle);
    }
  }
  for (const view of views) { budget.revokeView(view); budget.disposeView(view); }
  expect(budget.status()).toEqual({ ...empty, captureOccupied: false });
});
