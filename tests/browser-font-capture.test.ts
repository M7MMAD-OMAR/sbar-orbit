import { expect, test } from "bun:test";
import { call, startBroker } from "../src/ipc";
import { expectDeclaredImage } from "./frame-format";

test("the viewer captures current pixels while a web font remains pending", async () => {
  let fontRequests = 0;
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch(request) {
    if (new URL(request.url).pathname === "/pending.woff2") {
      fontRequests++;
      return new Response(new ReadableStream<Uint8Array>(), { headers: { "Content-Type": "font/woff2" } });
    }
    return new Response('<!doctype html><style>@font-face{font-family:Pending;src:url(/pending.woff2);font-display:swap}'
      + 'body{font-family:Pending,sans-serif}</style><h1>Current pixels</h1><output id="font">pending</output>'
      + '<script>document.fonts.load("16px Pending");document.fonts.ready.then(()=>document.querySelector("#font").textContent="complete")</script>',
      { headers: { "Content-Type": "text/html" } });
  } });
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });
    const frame = await call(broker.socket, "session.observe", session) as { mimeType: string; image: string; width: number; height: number };
    expectDeclaredImage(frame, "image/jpeg");
    expect(frame).toMatchObject({ width: 1280, height: 800 });
    expect(fontRequests).toBe(1);
    expect(await act({ type: "read", selector: "#font" })).toEqual({ text: "pending" });
  } finally { await broker.close(); fixture.stop(true); }
}, 30000);
