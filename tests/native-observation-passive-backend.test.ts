import { expect, test } from "bun:test";
import { NativeBackend } from "../src/hyprland";

const appId = "a".repeat(32), windowId = "b".repeat(32), siblingId = "c".repeat(32);
const selected = { appId, windowId };
function frame(format: "image" | "text" | "both" = "image"): Record<string, unknown> {
  return { ...selected, mimeType: format === "text" ? "text/x-orbit-a11y" : "image/png",
    ...(format === "text" ? {} : { image: "owned-fixture-pixels" }),
    width: 800, height: 400, surfaceWidth: 400, surfaceHeight: 200, pointer: null,
    ...(format === "image" ? {} : { tree: { status: "ok", complete: true, nodes: [] } }),
    windows: [{ ...selected, title: "Observed", width: 400, height: 200 },
      { appId, windowId: siblingId, title: "Unselected private sibling", width: 100, height: 100 }],
    observation: { mode: "passive-v1", cursorRefresh: "omitted", requestedFormat: format, returnedFormat: format === "text" ? "text" : "image" } };
}
function snapshot(backend: NativeBackend) {
  return JSON.stringify({ selected: Reflect.get(backend, "selected"), size: Reflect.get(backend, "size"),
    pointer: Reflect.get(backend, "pointer"), windows: [...Reflect.get(backend, "windows")], scales: [...Reflect.get(backend, "scales")] });
}
function fixture(reply = frame()) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let response: () => Promise<unknown> = async () => reply;
  const worker = { request: async (method: string, params: Record<string, unknown>) => { requests.push({ method, params }); return response(); } };
  const Constructor = NativeBackend as unknown as new (worker: unknown, directory: string, options: unknown) => NativeBackend;
  const backend = new Constructor(worker, "/owned-fixture", {});
  (Reflect.get(backend, "applications") as Set<string>).add(appId);
  Reflect.set(backend, "selected", { appId, windowId: siblingId });
  Reflect.set(backend, "pointer", { x: 30, y: 40 });
  Reflect.set(backend, "size", { width: 100, height: 100 });
  (Reflect.get(backend, "windows") as Map<string, unknown>).set(siblingId, { appId, windowId: siblingId, title: "Writer", width: 100, height: 100 });
  (Reflect.get(backend, "scales") as Map<string, unknown>).set(siblingId, { x: 1, y: 1 });
  return { backend, requests, respond: (next: () => Promise<unknown>) => { response = next; } };
}

for (const format of ["image", "text", "both"] as const) {
  test("passive " + format + " requires exact acknowledgement and leaves writer state unchanged", async () => {
    const { backend, requests } = fixture(frame(format));
    const before = snapshot(backend);
    const result = await backend.observePassive(selected, format, 700);
    expect(requests).toEqual([{ method: "act", params: { type: "observe", ...selected,
      ...(format === "image" ? {} : { format }), observationMode: "passive-v1", observationTimeoutMs: 700 } }]);
    expect(snapshot(backend)).toBe(before);
    expect(result).not.toHaveProperty("windows");
    expect(result.presence.tabs).toEqual([{ tab: 1, label: "Observed", active: true, ...selected }]);
    expect(JSON.stringify(result)).not.toContain("private sibling");
    expect(result.presence.sampled).toBe("capture-target metadata");
  });
}

for (const [label, patch] of [
  ["no acknowledgement", { observation: undefined }], ["null acknowledgement", { observation: null }],
  ["array acknowledgement", { observation: [] }], ["old mode", { observation: { mode: "passive-v0", cursorRefresh: "omitted" } }],
  ["refresh not omitted", { observation: { mode: "passive-v1", cursorRefresh: "performed" } }],
] as [string, Record<string, unknown>][]) {
  test(label + " refuses without legacy fallback or state changes", async () => {
    const { backend, requests } = fixture({ ...frame(), ...patch });
    const before = snapshot(backend);
    await expect(backend.observePassive(selected)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(requests).toHaveLength(1); expect(snapshot(backend)).toBe(before);
  });
}

test("passive old-worker response without inline windows never makes a second read", async () => {
  const value = frame(); delete value.windows;
  const { backend, requests } = fixture(value);
  const before = snapshot(backend);
  await expect(backend.observePassive(selected)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(requests).toHaveLength(1); expect(snapshot(backend)).toBe(before);
});

test("passive text unavailable stays text, but a worker image fallback refuses", async () => {
  const unavailable = frame("text"); unavailable.tree = { status: "unavailable", reason: "owned fixture unavailable" };
  const { backend, requests } = fixture(unavailable);
  expect(await backend.observePassive(selected, "text")).toHaveProperty("tree.status", "unavailable");
  const before = snapshot(backend);
  const image = frame("image");
  const state = fixture(image);
  await expect(state.backend.observePassive(selected, "text")).rejects.toMatchObject({ code: "BACKEND_ERROR" });
  expect(state.requests).toHaveLength(1); expect(requests).toHaveLength(1); expect(snapshot(backend)).toBe(before);
});

test("passive observation never overwrites writer state changed while the read waits", async () => {
  const { backend, respond } = fixture();
  const pending = Promise.withResolvers<unknown>();
  respond(() => pending.promise);
  const read = backend.observePassive(selected);
  Reflect.set(backend, "selected", { appId, windowId: "d".repeat(32) });
  Reflect.set(backend, "pointer", { x: 91, y: 92 });
  const before = snapshot(backend);
  pending.resolve(frame()); await read;
  expect(snapshot(backend)).toBe(before);
});

test("passive target capture cannot return another app/window or malformed geometry", async () => {
  for (const patch of [{ appId: "d".repeat(32) }, { windowId: siblingId }, { width: Infinity },
    { surfaceWidth: 0 }, { pointer: { x: 400, y: 2 } }, { windows: [] },
    { windows: [{ ...selected, title: "Bad", width: "400", height: 200 }] }]) {
    const { backend, requests } = fixture({ ...frame(), ...patch });
    const before = snapshot(backend);
    await expect(backend.observePassive(selected)).rejects.toBeInstanceOf(Error);
    expect(requests).toHaveLength(1); expect(snapshot(backend)).toBe(before);
  }
});

test("passive explicit target, format and finite integer deadline are validated before worker work", async () => {
  const { backend, requests } = fixture();
  for (const value of [undefined, null, {}, { appId }, { appId: siblingId, windowId }])
    await expect(backend.observePassive(value)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  for (const budget of [0, 99, 3001, Infinity, NaN, 100.5])
    await expect(backend.observePassive(selected, "image", budget)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(backend.observePassive(selected, "unknown" as "image")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(requests).toHaveLength(0);
});

test("passive response after app closure cannot commit or export a frame", async () => {
  const { backend, respond } = fixture();
  respond(async () => { (Reflect.get(backend, "applications") as Set<string>).delete(appId); return frame(); });
  const before = snapshot(backend);
  await expect(backend.observePassive(selected)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(snapshot(backend)).toBe(before);
});

test("legacy action parsing does not accept a model-supplied observation mode", async () => {
  const { backend, requests } = fixture();
  await expect(backend.act({ type: "key", ...selected, key: "Return", observationMode: "passive-v1" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(requests).toHaveLength(0);
});
