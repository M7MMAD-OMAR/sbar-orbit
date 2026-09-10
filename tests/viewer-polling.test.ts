import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

/** Execute the real viewer against a deterministic DOM/RPC clock, without Chrome. */
async function harness() {
  const elements = new Map<string, any>(), timers: { run: () => unknown; delay: number }[] = [];
  const calls: string[] = [];
  let fail = false, decoded = 0, closed = 0;
  const makeElement = () => ({ value: "", hidden: false, textContent: "", disabled: false,
    dataset: {}, style: {}, classList: { toggle() {} }, listeners: new Map<string, () => void>(),
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); },
    replaceChildren() {}, append() {}, getContext() { return { drawImage() {} }; },
  });
  const element = (id: string): any => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); };
  const document = { hidden: false, getElementById: element, createElement: makeElement };
  const source = await readFile("viewer/viewer.js", "utf8");
  runInNewContext(source, { document, location: { hash: "#fixture-access" }, performance: { now: () => 0 },
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ run, delay }); }, setInterval() {},
    AbortSignal, Blob, Uint8Array, atob, Date,
    fetch: async (_url: string, request: { body: string }) => {
      const { method } = JSON.parse(request.body); calls.push(method);
      if (fail) throw new Error("Fixture disconnected");
      return { ok: true, json: async () => ({ ok: true, result: method === "session.list"
        ? [{ sessionId: "fixture", state: "running", backend: "browser" }]
        : { image: "", mimeType: "image/png", width: 1280, height: 800, capturedAt: Date.now() } }) };
    },
    createImageBitmap: async () => { decoded++; return { close() { closed++; } }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, document, timers, element, counts: () => ({ decoded, closed }), disconnect: () => { fail = true; },
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

test("disconnected viewer backs off instead of polling five times per second", async () => {
  const app = await harness();
  app.mode("smooth"); app.disconnect();
  for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
    await app.tick(); expect(app.timers[0]?.delay).toBe(delay);
  }
  expect(app.counts()).toEqual({ decoded: 1, closed: 1 });
  expect(app.timers.length).toBe(1);
});
