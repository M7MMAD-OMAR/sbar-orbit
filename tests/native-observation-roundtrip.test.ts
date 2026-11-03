import { describe, expect, test } from "bun:test";
import { NativeBackend } from "../src/hyprland";
import { OrbitError } from "../src/errors";

const appId = "a".repeat(32), windowId = "b".repeat(32), otherId = "c".repeat(32);
const selected = { appId, windowId };
const window = (title = "Saved") => ({ ...selected, title, width: 400, height: 200 });
function frame(format: "image" | "text" | "both" = "image"): Record<string, unknown> {
  return {
    ...selected, mimeType: format === "text" ? "text/x-orbit-a11y" : "image/png",
    ...(format === "text" ? {} : { image: "owned-fixture-pixels" }),
    width: 800, height: 400, surfaceWidth: 400, surfaceHeight: 200, pointer: { x: 10, y: 20 },
    ...(format === "image" ? {} : { tree: { status: "ok", nodes: [{ role: "label", name: "Owned fixture" }] } }),
    windows: [window()],
  };
}

// Source-only protocol fixtures. Counts are worker RPC counts, not wall-time performance evidence.
async function fixture(initial = frame()) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let observation = initial, windows: unknown = [window("Draft")];
  const worker = { request: async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    if (method !== "act") throw new Error("Unexpected owned fixture method");
    if (params.type === "observe") return observation;
    if (params.type === "windows") return { windows };
    return { ok: true };
  } };
  const Constructor = NativeBackend as unknown as new (worker: unknown, directory: string, options: unknown) => NativeBackend;
  const backend = new Constructor(worker, "/owned-fixture", {});
  (Reflect.get(backend, "applications") as Set<string>).add(appId);
  await backend.act({ type: "windows", appId });
  Reflect.set(backend, "selected", selected);
  requests.length = 0;
  windows = [window()];
  return { backend, requests, setFrame: (value: Record<string, unknown>) => { observation = value; }, setWindows: (value: unknown) => { windows = value; } };
}

function stateSnapshot(backend: NativeBackend) {
  return JSON.stringify({
    selected: Reflect.get(backend, "selected"), size: Reflect.get(backend, "size"), pointer: Reflect.get(backend, "pointer"),
    windows: [...Reflect.get(backend, "windows") as Map<string, unknown>],
    scales: [...Reflect.get(backend, "scales") as Map<string, unknown>],
  });
}

describe("inline observation acknowledgement", () => {
  for (const format of ["image", "text", "both"] as const) {
    test(format + " uses one RPC, refreshes saved title and strips internal windows", async () => {
      const { backend, requests } = await fixture(frame(format));
      const result = await backend.observe(selected, format);
      expect(requests.map(request => request.params.type)).toEqual(["observe"]);
      expect(result).not.toHaveProperty("windows");
      expect(result.presence.title).toBe("Saved");
      expect(result.presence.sampled).toBe("acknowledged metadata");
      expect(result.presence.pointer).toEqual({ x: 20, y: 40 });
      expect(result.presence.tabs).toEqual([{ tab: 1, label: "Saved", active: true, ...selected }]);
      if (format === "text") expect(result).not.toHaveProperty("image");
      else expect(result).toHaveProperty("image", "owned-fixture-pixels");
    });
  }
  test("legacy absent acknowledgement retains two RPCs and fresh title metadata", async () => {
    const legacy = frame(); delete legacy.windows;
    const { backend, requests } = await fixture(legacy);
    const result = await backend.observe(selected);
    expect(requests.map(request => request.params.type)).toEqual(["observe", "windows"]);
    expect(result.presence.title).toBe("Saved");
    expect(result).not.toHaveProperty("windows");
  });
  test("text request falling back to PNG accepts one inline acknowledgement", async () => {
    const { backend, requests } = await fixture(frame("both"));
    const result = await backend.observe(selected, "text");
    expect(result).toHaveProperty("mimeType", "image/png"); expect(requests).toHaveLength(1);
  });
  test("settle options and subsequent pixel pointer scale remain intact", async () => {
    const { backend, requests } = await fixture();
    await backend.observe(selected, "both", { since: "d".repeat(64), timeoutMs: 700, quietMs: 100 });
    expect(requests[0]!.params).toEqual({ type: "observe", ...selected, format: "both", since: "d".repeat(64), timeoutMs: 700, quietMs: 100 });
    await backend.act({ type: "click", ...selected, x: 30, y: 40 });
    expect((await backend.presence()).pointer).toEqual({ x: 60, y: 80 });
  });
  test("null pointer remains null", async () => {
    const value = frame(); value.pointer = null;
    const { backend } = await fixture(value);
    expect((await backend.observe()).presence.pointer).toBeNull();
  });
  test("newly acknowledged dialog is scoped and obsolete metadata is replaced", async () => {
    const value = frame(); value.windows = [window("Saved"), { ...window("Dialog"), windowId: otherId }];
    const { backend } = await fixture(value);
    expect((await backend.observe()).presence.pageCount).toBe(2);
  });
  test("unowned app is rejected without worker request", async () => {
    const { backend, requests } = await fixture();
    await expect(backend.observe({ appId: otherId, windowId })).rejects.toBeInstanceOf(OrbitError);
    expect(requests).toHaveLength(0);
  });
});

describe("malformed inline acknowledgement fails closed without fallback or partial state", () => {
  const invalidLists: [string, unknown][] = [
    ["undefined", undefined], ["null", null], ["object", {}], ["empty", []],
    ["missing selected", [{ ...window(), windowId: otherId }]],
    ["foreign application", [{ ...window(), appId: otherId }]],
    ["duplicate", [window(), window("Conflicting duplicate")]],
    ["invalid identity", [{ ...window(), windowId: "not-an-id" }]],
    ["nonfinite geometry", [{ ...window(), width: Infinity }]],
    ["NaN geometry", [{ ...window(), height: NaN }]],
    ["zero geometry", [{ ...window(), width: 0 }]],
    ["negative geometry", [{ ...window(), height: -1 }]],
    ["coerced geometry", [{ ...window(), width: "400" }]],
    ["bad title", [{ ...window(), title: null }]],
    ["late invalid entry", [window("Not committed"), { ...window(), windowId: otherId, height: NaN }]],
    ["sparse", Array(2)], ["excessive", Array(4097).fill(window())],
  ];
  for (const [label, windows] of invalidLists) {
    test(label, async () => {
      const value = frame(); value.windows = windows;
      const { backend, requests } = await fixture(value);
      const before = await backend.presence();
      await expect(backend.observe(selected)).rejects.toBeInstanceOf(OrbitError);
      expect(requests.map(request => request.params.type)).toEqual(["observe"]);
      expect(await backend.presence()).toEqual(before);
    });
  }
  test("window ID collision with another owned app is refused", async () => {
    const value = frame(); value.windows = [window(), { ...window(), windowId: otherId }];
    const { backend } = await fixture(value);
    (Reflect.get(backend, "windows") as Map<string, unknown>).set(otherId, { ...window("Other app"), appId: "d".repeat(32), windowId: otherId });
    const before = await backend.presence();
    await expect(backend.observe()).rejects.toBeInstanceOf(OrbitError);
    expect(await backend.presence()).toEqual(before);
  });
  for (const [label, patch] of [
    ["wrong target", { windowId: otherId }], ["infinite pixels", { width: Infinity }],
    ["zero surface", { surfaceWidth: 0 }], ["string surface", { surfaceHeight: "200" }],
    ["bad pointer", { pointer: { x: NaN, y: 1 } }], ["outside pointer", { pointer: { x: 400, y: 1 } }],
    ["negative pointer", { pointer: { x: -1, y: 1 } }], ["coerced pointer", { pointer: { x: "1", y: 1 } }],
    ["missing pointer", { pointer: undefined }], ["overflow scale", { width: 1e308, surfaceWidth: 1e-308 }],
    ["underflow scale", { width: Number.MIN_VALUE, surfaceWidth: 1e308 }],
  ] as [string, Record<string, unknown>][]) {
    test(label + " cannot commit valid inline metadata", async () => {
      const { backend, requests } = await fixture({ ...frame(), ...patch });
      const before = await backend.presence();
      await expect(backend.observe()).rejects.toBeInstanceOf(OrbitError);
      expect(requests).toHaveLength(1); expect(await backend.presence()).toEqual(before);
    });
  }
  for (const [label, windows] of [
    ["empty", []], ["missing selected", [{ ...window(), windowId: otherId }]],
    ["undefined", undefined], ["null", null], ["not array", {}],
    ["duplicate", [window(), window()]],
    ["late invalid", [window("Not committed"), { ...window(), windowId: otherId, width: Infinity }]],
  ] as [string, unknown][]) {
    test("legacy " + label + " preserves all observation state", async () => {
      const legacy = frame(); delete legacy.windows;
      legacy.width = 600; legacy.height = 300; legacy.pointer = { x: 30, y: 40 };
      const { backend, requests, setWindows } = await fixture(legacy);
      // Establish non-default pointer and scale state before the rejected observation.
      const valid = frame();
      const worker = Reflect.get(backend, "worker") as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> };
      const original = worker.request;
      worker.request = async (method, params) => params.type === "observe" ? valid : original(method, params);
      await backend.observe();
      worker.request = original; requests.length = 0;
      setWindows(windows);
      const before = stateSnapshot(backend);
      await expect(backend.observe()).rejects.toBeInstanceOf(OrbitError);
      expect(requests.map(request => request.params.type)).toEqual(["observe", "windows"]);
      expect(stateSnapshot(backend)).toBe(before);
    });
  }
  for (const phase of ["observe", "windows"]) {
    test("legacy app closed during " + phase + " cannot commit observation", async () => {
      const legacy = frame(); delete legacy.windows;
      const { backend, requests } = await fixture(legacy);
      const worker = Reflect.get(backend, "worker") as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> };
      const original = worker.request;
      worker.request = async (method, params) => {
        const result = await original(method, params);
        if (params.type === phase) (Reflect.get(backend, "applications") as Set<string>).delete(appId);
        return result;
      };
      const before = stateSnapshot(backend);
      await expect(backend.observe()).rejects.toBeInstanceOf(OrbitError);
      expect(requests.map(request => request.params.type)).toEqual(phase === "observe" ? ["observe"] : ["observe", "windows"]);
      expect(stateSnapshot(backend)).toBe(before);
    });
  }
  test("legacy windows read shares strict atomic metadata validation", async () => {
    const legacy = frame(); delete legacy.windows;
    const { backend, requests, setWindows } = await fixture(legacy);
    setWindows([window("Not committed"), { ...window(), windowId: otherId, width: Infinity }]);
    const before = await backend.presence();
    await expect(backend.observe()).rejects.toBeInstanceOf(OrbitError);
    expect(requests.map(request => request.params.type)).toEqual(["observe", "windows"]);
    expect(await backend.presence()).toEqual(before);
  });
});
