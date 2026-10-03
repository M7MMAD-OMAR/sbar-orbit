import { expect, test } from "bun:test";
import { call, startBroker } from "../src/ipc";

for (const type of ["navigate", "open-tab"] as const) {
  test(`${type} returns when the document is ready despite a pending image`, async () => {
    let pendingImageRequests = 0;
    let imageStarted: (() => void) | undefined;
    const imageRequested = new Promise<void>(resolve => { imageStarted = resolve; });
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch(request) {
      if (new URL(request.url).pathname === "/pending.png") {
        pendingImageRequests++;
        imageStarted?.();
        return new Response(new ReadableStream<Uint8Array>(), { headers: { "Content-Type": "image/png" } });
      }
      return new Response('<!doctype html><title>Ready document</title><h1 id="ready">Document ready</h1>'
        + '<img src="/pending.png"><output id="load">pending</output>'
        + '<script>addEventListener("load",()=>document.querySelector("#load").textContent="complete")</script>',
        { headers: { "Content-Type": "text/html" } });
    } });
    const broker = await startBroker();
    try {
      const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
      const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
      const url = `http://127.0.0.1:${fixture.port}/`;
      expect(await act({ type, url })).toMatchObject({ url });
      expect(await act({ type: "read", selector: "#ready" })).toEqual({ text: "Document ready" });
      // DOM readiness can precede the server observing the image request.
      // Wait for that request while leaving the image response unfinished.
      let requestTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([imageRequested, new Promise<never>((_, reject) => {
          requestTimeout = setTimeout(() => reject(new Error("Pending image was never requested")), 5000);
        })]);
      } finally { clearTimeout(requestTimeout); }
      expect(pendingImageRequests).toBe(1);
      expect(await act({ type: "read", selector: "#load" })).toEqual({ text: "pending" });
    } finally { await broker.close(); fixture.stop(true); }
  }, 30000);
}
