import { expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { openEgressLease } from "../src/egress";
import { fixtureRoot } from "./platform-support";

const payload = Buffer.alloc(16 * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function readSlow(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("error", reject);
    socket.setTimeout(8000, () => socket.destroy(new Error("Fixture receive deadline")));
    socket.pause();
    setTimeout(() => socket.resume(), 300);
  });
}

test.if(process.platform === "linux")("the namespace CONNECT tunnel preserves a large response for a paused reader", async () => {
  const root = await fixtureRoot("orbit-proxy-pressure-");
  const upstreams = new Set<Socket>();
  const target = createServer(socket => { upstreams.add(socket); socket.once("close", () => upstreams.delete(socket)); socket.end(payload); });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  let client: Socket | undefined;
  try {
    lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/true", profile: join(root, "profile"),
      confinable: true, origins: () => [`https://127.0.0.1:${address.port}`] });
    expect(lease.tier).toBe("namespace");
    client = createConnection({ path: join(root, "egress", "lease.sock") });
    await once(client, "connect");
    const received = readSlow(client);
    client.write(`CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
    const reply = await received;
    const headerEnd = reply.indexOf("\r\n\r\n");
    expect(reply.subarray(0, headerEnd + 4).toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    const body = reply.subarray(headerEnd + 4);
    expect(body.length).toBe(payload.length);
    expect(digest(body)).toBe(digest(payload));
  } finally {
    client?.destroy(); for (const socket of upstreams) socket.destroy();
    target.close(); await lease?.close(); await rm(root, { recursive: true, force: true });
  }
}, 15000);

for (const direction of ["browser-to-host", "host-to-browser"] as const) {
  test.if(process.platform === "linux")(`the CDP relay preserves large ${direction} data for a paused reader`, async () => {
    const root = await fixtureRoot("orbit-cdp-pressure-");
    let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
    let host: Socket | undefined;
    let browser: Socket | undefined;
    try {
      lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/true", profile: join(root, "profile"),
        confinable: true, origins: () => ["https://example.com"] });
      expect(lease.tier).toBe("namespace");
      host = createConnection({ host: "127.0.0.1", port: lease.endpointPort });
      browser = createConnection({ path: join(root, "egress", "cdp.sock") });
      await Promise.all([once(host, "connect"), once(browser, "connect")]);
      const reader = direction === "browser-to-host" ? host : browser;
      const writer = direction === "browser-to-host" ? browser : host;
      const received = readSlow(reader);
      writer.end(payload);
      const body = await received;
      expect(body.length).toBe(payload.length);
      expect(digest(body)).toBe(digest(payload));
    } finally {
      host?.destroy(); browser?.destroy(); await lease?.close(); await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}

test.if(process.platform === "linux")("the CDP relay preserves a handshake sent before its browser peer connects", async () => {
  const root = await fixtureRoot("orbit-cdp-handshake-");
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  let host: Socket | undefined;
  let browser: Socket | undefined;
  const request = "GET /json/version HTTP/1.1\r\nHost: localhost\r\n\r\n";
  const response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
  try {
    lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/true", profile: join(root, "profile"),
      confinable: true, origins: () => ["https://example.com"] });
    expect(lease.tier).toBe("namespace");
    host = createConnection({ host: "127.0.0.1", port: lease.endpointPort });
    await once(host, "connect");
    const reply = readSlow(host);
    host.write(request);
    await new Promise(resolve => setTimeout(resolve, 50));
    browser = createConnection({ path: join(root, "egress", "cdp.sock") });
    browser.setTimeout(3000, () => browser?.destroy(new Error("Handshake deadline")));
    const [chunk] = await once(browser, "data");
    expect(chunk.toString()).toBe(request);
    browser.end(response);
    expect((await reply).toString()).toBe(response);
  } finally {
    host?.destroy(); browser?.destroy(); await lease?.close(); await rm(root, { recursive: true, force: true });
  }
}, 10000);
