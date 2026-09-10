import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

/** Execute the real viewer against a deterministic DOM/RPC clock, without Chrome. */
async function harness() {
  const elements = new Map<string, any>(), timers: { run: () => unknown; delay: number }[] = [];
  const calls: string[] = [];
  let fail = false, decoded = 0, closed = 0, drawn = 0;
  let observeGate: Promise<void> | undefined, decodeGate: Promise<void> | undefined, listGate: Promise<void> | undefined;
  const intervals: (() => void)[] = [];
  const makeElement = () => ({ value: "", hidden: false, textContent: "", disabled: false,
    dataset: {}, style: {}, classList: { toggle() {} }, listeners: new Map<string, () => void>(),
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); },
    replaceChildren() {}, append() {}, getContext() { return { drawImage() { drawn++; } }; },
  });
  const element = (id: string): any => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); };
  const document = { hidden: false, getElementById: element, createElement: makeElement };
  const source = await readFile("viewer/viewer.js", "utf8");
  runInNewContext(source, { document, location: { hash: "#fixture-access" }, performance: { now: () => 0 },
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ run, delay }); }, setInterval(run: () => void) { intervals.push(run); },
    AbortSignal, Blob, Uint8Array, atob, Date,
    fetch: async (_url: string, request: { body: string }) => {
      const { method } = JSON.parse(request.body); calls.push(method);
      if (fail) throw new Error("Fixture disconnected");
      if (method === "session.list") await listGate;
      if (method === "session.observe") await observeGate;
      return { ok: true, json: async () => ({ ok: true, result: method === "session.list"
        ? [{ sessionId: "fixture", state: "running", backend: "browser" }]
        : { image: "", mimeType: "image/png", width: 1280, height: 800, capturedAt: Date.now() } }) };
    },
    createImageBitmap: async () => { decoded++; await decodeGate; return { close() { closed++; } }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, document, timers, element, counts: () => ({ decoded, closed }), disconnect: () => { fail = true; },
    draws: () => drawn, intervals,
    holdList() { let release!: () => void; listGate = new Promise(resolve => { release = resolve; }); return release; },
    holdObserve() { let release!: () => void; observeGate = new Promise(resolve => { release = resolve; }); return release; },
    holdDecode() { let release!: () => void; decodeGate = new Promise(resolve => { release = resolve; }); return release; },
    async tick() { const timer = timers.shift(); if (!timer) throw new Error("No scheduled poll"); await timer.run(); },
    mode(value: string) { element("preview-mode").value = value; element("preview-mode").listeners.get("change")(); },
  };
}

test("viewer defaults to 1 FPS, captures only on request in manual mode, and stops hidden work", async () => {
  const app = await harness();
  expect(app.timers[0]?.delay).toBe(1000);
  expect(app.counts()).toEqual({ decoded: 1, closed: 1 });
  app.mode("manual");
  await app.tick(); await app.tick();
  expect(app.calls.filter(method => method === "session.observe").length).toBe(1);
  app.element("refresh-frame").onclick();
  await app.tick(); await app.tick();
  expect(app.counts()).toEqual({ decoded: 2, closed: 2 });
  app.document.hidden = true;
  const before = app.calls.length;
  await app.tick();
  expect(app.calls.length).toBe(before);
  app.document.hidden = false;
  app.mode("smooth");
  await app.tick();
  expect(app.timers[0]?.delay).toBe(200);
  expect(app.counts()).toEqual({ decoded: 3, closed: 3 });
});

test("a tab hidden during capture does not decode the arriving frame", async () => {
  const app = await harness();
  const release = app.holdObserve();
  const pending = app.tick();
  await new Promise(resolve => setImmediate(resolve));
  app.document.hidden = true;
  release(); await pending;
  expect(app.counts()).toEqual({ decoded: 1, closed: 1 });
  expect(app.draws()).toBe(1);
  expect(app.timers.length).toBe(1);
  app.document.hidden = false;
  await app.tick();
  expect(app.counts()).toEqual({ decoded: 2, closed: 2 });
});

test("a tab hidden during session listing starts no capture", async () => {
  const app = await harness();
  const release = app.holdList();
  const pending = app.tick();
  await new Promise(resolve => setImmediate(resolve));
  app.document.hidden = true;
  release(); await pending;
  expect(app.calls.filter(method => method === "session.observe").length).toBe(1);
  expect(app.counts()).toEqual({ decoded: 1, closed: 1 });
});

test("a tab hidden during decode releases the bitmap without drawing or updating freshness", async () => {
  const app = await harness();
  const release = app.holdDecode();
  const pending = app.tick();
  await new Promise(resolve => setImmediate(resolve));
  app.document.hidden = true;
  release(); await pending;
  expect(app.counts()).toEqual({ decoded: 2, closed: 2 });
  expect(app.draws()).toBe(1);
  app.element("freshness").textContent = "Fixture unchanged";
  app.intervals.forEach(run => run());
  expect(app.element("freshness").textContent).toBe("Fixture unchanged");
});

test("disconnected viewer backs off instead of polling five times per second", async () => {
  const app = await harness();
  app.mode("smooth"); app.disconnect();
  for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
    await app.tick(); expect(app.timers[0]?.delay).toBe(delay);
  }
  expect(app.counts()).toEqual({ decoded: 1, closed: 1 });
  expect(app.timers.length).toBe(1);
});
