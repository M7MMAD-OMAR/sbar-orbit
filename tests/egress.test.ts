import { test, expect } from "bun:test";
import { connect, listen } from "bun";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { leasedAuthorities, openEgressLease, openPublicWebLease } from "../src/egress";
import { detectPlatform } from "../src/platform";
import { Sessions } from "../src/session";
import type { CloneResult } from "../src/clone";
import { AccountLease } from "../src/profiles";
import { expectPrivatePath } from "./private-path";
import { fixtureRoot, needsSymlink } from "./platform-support";

const confinable = (await detectPlatform()).confinedEgress;

/** Speak to the lease the way a browser does, and report exactly what came back. */
async function throughProxy(socketPath: string, request: string, expectBytes = true, maxAttempts = 100): Promise<{ reply: string }> {
  let reply = "";
  const client = await connect<undefined>({
    unix: socketPath,
    socket: { data: (_socket, chunk) => { reply += new TextDecoder().decode(chunk); }, close: () => {}, error: () => {} },
  });
  client.write(request);
  for (let attempt = 0; attempt < maxAttempts && (expectBytes ? !reply : attempt < 20); attempt++) await Bun.sleep(20);
  client.end();
  return { reply };
}

test("what a lease on an origin means to a proxy that is only told an authority", () => {
  // CONNECT names host and port and nothing else, so this is the resolution the layer below the
  // browser can work at. The default port is implied by the scheme and the tunnel will not say it.
  expect(leasedAuthorities(["https://example.com"])).toEqual(["example.com:443"]);
  expect(leasedAuthorities(["http://example.com"])).toEqual(["example.com:80"]);
  expect(leasedAuthorities(["http://127.0.0.1:8080"])).toEqual(["127.0.0.1:8080"]);
  // Both schemes of one host collapse to two authorities, not one.
  expect(leasedAuthorities(["https://a.test", "http://a.test"]).sort()).toEqual(["a.test:443", "a.test:80"]);
  // Deduplicated, and anything that is not an origin an http lease can mean is dropped rather than
  // guessed at.
  expect(leasedAuthorities(["https://a.test", "https://a.test"])).toEqual(["a.test:443"]);
  expect(leasedAuthorities(["chrome://settings", "not a url", "file:///etc"])).toEqual([]);
});

test("a host that cannot confine a browser says so instead of pretending", async () => {
  const root = await fixtureRoot("orbit-egress-tier-");
  try {
    const lease = await openEgressLease({
      directory: join(root, "egress"), executable: "/opt/google/chrome/chrome",
      profile: join(root, "profile"), confinable: false, origins: () => ["https://a.test"],
    });
    // The tier drops, the session still runs, and the browser is started as it always was.
    expect(lease.tier).toBe("in-browser");
    expect(lease.launch.executable).toBe("/opt/google/chrome/chrome");
    expect(lease.launch.args).toEqual([]);
    expect(lease.endpointPort).toBe(0);
    expect(lease.refused()).toEqual([]);
    // And nothing was built: no sockets, no wrapper, no directory.
    await expect(stat(join(root, "egress"))).rejects.toThrow();
    await lease.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a path too long for a unix socket drops the tier instead of truncating it", async () => {
  const root = await fixtureRoot("orbit-egress-long-");
  // 108 bytes is the kernel's limit, and past it the path is silently shortened: the relay binds one
  // path, nothing dials it, and the session waits out its deadline on a browser that started perfectly.
  const tooLong = join(root, "a".repeat(120));
  try {
    const lease = await openEgressLease({
      directory: tooLong, executable: "/opt/google/chrome/chrome",
      profile: join(root, "profile"), confinable: true, origins: () => ["https://a.test"],
    });
    expect(lease.tier).toBe("in-browser");
    await expect(stat(tooLong)).rejects.toThrow();
    await lease.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("the lease forwards the authorities it holds and refuses the rest", async () => {
  const root = await fixtureRoot("orbit-egress-proxy-");
  let reached = 0;
  const target = listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { open: socket => { reached++; socket.end(); }, data: () => {}, close: () => {} } });
  let origins = [`https://127.0.0.1:${target.port}`];
  try {
    const lease = await openEgressLease({
      directory: join(root, "egress"), executable: "/opt/google/chrome/chrome",
      profile: join(root, "profile"), confinable: true, origins: () => origins,
    });
    expect(lease.tier).toBe("namespace");
    const socketPath = join(root, "egress", "lease.sock");
    // The directory holds a live route out of a session carrying real logins.
    await expectPrivatePath(join(root, "egress"), 0o700);

    // A leased authority is tunnelled: the far end saw a connection, which is the only evidence that
    // does not depend on what the browser was told.
    const allowed = await throughProxy(socketPath, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`);
    expect(allowed.reply).toContain("200 Connection Established");
    expect(reached).toBe(1);

    // An unleased one is refused before anything is opened, and recorded as refused.
    const denied = await throughProxy(socketPath, "CONNECT unleased.test:443 HTTP/1.1\r\nHost: unleased.test:443\r\n\r\n");
    expect(denied.reply).toContain("403");
    expect(reached).toBe(1);
    expect(lease.refused()).toEqual(["unleased.test:443"]);

    // Plain HTTP carries the scheme, so at this layer the same host on the other scheme is a different
    // thing and is refused, even though its authority differs only in the port the lease implied.
    const wrongScheme = await throughProxy(socketPath, `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`);
    expect(wrongScheme.reply).toContain("403");
    expect(reached).toBe(1);

    // Narrowing reaches this layer too. The origins are read on every request rather than copied when
    // the lease was opened, so a session that tightens itself tightens the route out as well.
    origins = [];
    const afterNarrowing = await throughProxy(socketPath, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`);
    expect(afterNarrowing.reply).toContain("403");
    expect(reached).toBe(1);
    expect(lease.refused()).toContain(`127.0.0.1:${target.port}`);

    // A request line that never ends forwards nothing and is dropped rather than buffered forever.
    const unterminated = await throughProxy(socketPath, "GET http://a.test/ HTTP/1.1\r\nHost: a.test\r\n", false);
    expect(unterminated.reply).toBe("");

    await lease.close();
    // Closing takes the sockets and the wrapper with it: a route out that outlives its session is a
    // route out nothing is watching.
    await expect(stat(join(root, "egress"))).rejects.toThrow();
  } finally { target.stop(true); await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("a leased public name cannot rebind to a loopback address", async () => {
  const root = await fixtureRoot("orbit-egress-rebind-");
  let reached = 0;
  const target = listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: {
    open(socket) { reached++; socket.end(); }, data: () => {}, close: () => {},
  } });
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  try {
    lease = await openEgressLease({
      directory: join(root, "egress"), executable: "/usr/bin/python3", profile: join(root, "profile"),
      confinable: true, origins: () => [`https://allowed.example:${target.port}`],
      resolveHost: async () => ["127.0.0.1"],
    });
    const denied = await throughProxy(join(root, "egress", "lease.sock"),
      `CONNECT allowed.example:${target.port} HTTP/1.1\r\nHost: allowed.example:${target.port}\r\n\r\n`);
    expect(denied.reply).toContain("403");
    expect(reached).toBe(0);
    expect(lease.refused()).toContain(`allowed.example:${target.port}`);
  } finally { await lease?.close(); target.stop(true); await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("public names refuse private, reserved and IPv4 mapped DNS answers", async () => {
  const root = await fixtureRoot("orbit-egress-private-dns-");
  let answer = "127.0.0.1";
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  try {
    lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/python3",
      profile: join(root, "profile"), confinable: true, origins: () => ["https://allowed.example"],
      resolveHost: async () => [answer] });
    for (answer of ["127.0.0.1", [10, 0, 0, 1].join("."), "100.64.0.1", "169.254.1.1",
      [172, 16, 0, 1].join("."), [192, 168, 1, 1].join("."), "::1", "fc00::1", "fe80::1",
      "::ffff:127.0.0.1", "2001:db8::1"]) {
      const denied = await throughProxy(join(root, "egress", "lease.sock"),
        "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n");
      expect(denied.reply).toContain("403");
    }
  } finally { await lease?.close(); await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("a DNS resolver that never answers cannot hold the proxy open forever", async () => {
  const root = await fixtureRoot("orbit-egress-dns-timeout-");
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  try {
    lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/python3",
      profile: join(root, "profile"), confinable: true, origins: () => ["https://allowed.example"],
      resolveHost: async () => new Promise<string[]>(() => {}) });
    const denied = await throughProxy(join(root, "egress", "lease.sock"),
      "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n", true, 400);
    expect(denied.reply).toContain("403");
  } finally { await lease?.close(); await rm(root, { recursive: true, force: true }); }
}, 12000);

test.if(confinable)("an explicitly leased localhost name reaches loopback only", async () => {
  const root = await fixtureRoot("orbit-egress-localhost-");
  let answers = ["::1", "127.0.0.1"];
  let reached = 0;
  const target = listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: {
    open(socket) { reached++; socket.end(); }, data: () => {}, close: () => {},
  } });
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  try {
    lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/python3",
      profile: join(root, "profile"), confinable: true,
      origins: () => [`http://localhost:${target.port}`], resolveHost: async () => answers });
    const request = `CONNECT localhost:${target.port} HTTP/1.1\r\nHost: localhost:${target.port}\r\n\r\n`;
    const allowed = await throughProxy(join(root, "egress", "lease.sock"), request);
    expect(allowed.reply).toContain("200 Connection Established");
    expect(reached).toBe(1);
    answers = [[10, 0, 0, 1].join(".")];
    const denied = await throughProxy(join(root, "egress", "lease.sock"), request);
    expect(denied.reply).toContain("403");
    expect(reached).toBe(1);
  } finally { await lease?.close(); target.stop(true); await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("plain HTTP Host must match the leased absolute URL", async () => {
  const root = await fixtureRoot("orbit-egress-host-");
  let reached = 0;
  const target = listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: {
    open(socket) { reached++; socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); socket.end(); }, data: () => {}, close: () => {},
  } });
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  try {
    lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/python3",
      profile: join(root, "profile"), confinable: true,
      origins: () => [`http://127.0.0.1:${target.port}`] });
    const socketPath = join(root, "egress", "lease.sock");
    const url = `http://127.0.0.1:${target.port}/`;
    const wrong = await throughProxy(socketPath, `GET ${url} HTTP/1.1\r\nHost: other.test\r\n\r\n`);
    expect(wrong.reply).toContain("403");
    const duplicate = await throughProxy(socketPath, `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nHost: other.test\r\n\r\n`);
    expect(duplicate.reply).toContain("403");
    const paddedName = await throughProxy(socketPath, `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nHost : other.test\r\n\r\n`);
    expect(paddedName.reply).toContain("403");
    const bareLf = await throughProxy(socketPath, `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nX-Filler: ok\nHost: other.test\r\n\r\n`);
    expect(bareLf.reply).toContain("403");
    expect(reached).toBe(0);
    const matching = await throughProxy(socketPath, `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`);
    expect(matching.reply).toContain("200 OK");
    expect(reached).toBe(1);
  } finally { await lease?.close(); target.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("public web lease routes two HTTP hosts on one proxy connection without cross-host forwarding", async () => {
  const root = await fixtureRoot("opw-", process.platform === "darwin" ? "/tmp" : undefined);
  const loopback = [127, 0, 0, 1].join(".");
  const seenA: string[] = [], seenB: string[] = [], dialed: string[] = [], resolved: string[] = [];
  let firstRequest = "";
  const a = listen<undefined>({ hostname: loopback, port: 0, socket: {
    open: () => {}, data(socket, chunk) {
      firstRequest += new TextDecoder().decode(chunk);
      if (!firstRequest.includes("\r\n\r\nping")) return;
      seenA.push(firstRequest);
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nfirst-body");
      socket.end();
    }, close: () => {},
  } });
  const b = listen<undefined>({ hostname: loopback, port: 0, socket: {
    open: () => {}, data(socket, chunk) {
      seenB.push(new TextDecoder().decode(chunk));
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nsecond-body");
      socket.end();
    }, close: () => {},
  } });
  let lease: Awaited<ReturnType<typeof openPublicWebLease>> | undefined;
  let client: Awaited<ReturnType<typeof connect<undefined>>> | undefined;
  try {
    lease = await openPublicWebLease({ parentDirectory: root, origins: ["http://a.example", "http://b.example"],
      resolveHost: async host => { resolved.push(host); return host === "a.example" ? ["8.8.8.8"] : ["1.1.1.1"]; },
      routeForTest: (address, port) => {
        dialed.push(`${address}:${port}`);
        return { address: loopback, port: address === "8.8.8.8" ? a.port : b.port };
      },
    });
    let reply = "";
    let closed = false;
    client = await connect<undefined>({ unix: lease.socketPath, socket: {
      data: (_socket, chunk) => { reply += new TextDecoder().decode(chunk); },
      close: () => { closed = true; }, error: () => {},
    } });
    client.write("POST http://a.example/first HTTP/1.1\r\nHost: a.example\r\nContent-Length: 4\r\n\r\nping");
    for (let i = 0; i < 100 && !reply.includes("first-body"); i++) await Bun.sleep(20);
    expect(reply).toContain("first-body");
    expect(closed).toBe(false);
    client.write("GET http://b.example/second HTTP/1.1\r\nHost: b.example\r\n\r\n");
    for (let i = 0; i < 100 && !reply.includes("second-body"); i++) await Bun.sleep(20);
    expect(reply).toContain("second-body");
    expect(seenA).toHaveLength(1);
    expect(seenA[0]).toContain("POST /first HTTP/1.1");
    expect(seenA[0]).toContain("\r\n\r\nping");
    expect(seenA[0]).not.toContain("b.example");
    expect(seenB).toHaveLength(1);
    expect(seenB[0]).toContain("GET /second HTTP/1.1");
    expect(dialed).toEqual(["8.8.8.8:80", "1.1.1.1:80"]);
    expect(resolved).toEqual(["a.example", "b.example"]);
  } finally {
    client?.end();
    await lease?.close();
    a.stop(true); b.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("public web CONNECT keeps a delayed response stream open", async () => {
  const root = await fixtureRoot("opw-", process.platform === "darwin" ? "/tmp" : undefined);
  const loopback = [127, 0, 0, 1].join(".");
  let request = "";
  const target = listen<undefined>({ hostname: loopback, port: 0, socket: {
    open: () => {}, data(socket, chunk) {
      request += new TextDecoder().decode(chunk);
      if (!request.includes("\r\n\r\n") || !request.startsWith("GET /stream HTTP/1.1")) return;
      request = "handled";
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: first\n\n");
      setTimeout(() => { socket.write("data: second\n\n"); socket.end(); }, 180);
    }, close: () => {},
  } });
  let lease: Awaited<ReturnType<typeof openPublicWebLease>> | undefined;
  let client: Awaited<ReturnType<typeof connect<undefined>>> | undefined;
  try {
    lease = await openPublicWebLease({ parentDirectory: root, origins: ["https://public.example"],
      resolveHost: async () => ["8.8.8.8"],
      routeForTest: (address, port) => {
        expect(address).toBe("8.8.8.8");
        expect(port).toBe(443);
        return { address: loopback, port: target.port };
      },
    });
    let reply = "";
    client = await connect<undefined>({ unix: lease.socketPath, socket: {
      data: (_socket, chunk) => { reply += new TextDecoder().decode(chunk); },
      close: () => {}, error: () => {},
    } });
    client.write("CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n");
    for (let i = 0; i < 100 && !reply.includes("200 Connection Established"); i++) await Bun.sleep(20);
    expect(reply).toContain("200 Connection Established");
    client.write("GET /stream HTTP/1.1\r\nHost: public.example\r\n\r\n");
    for (let i = 0; i < 100 && !reply.includes("data: first"); i++) await Bun.sleep(20);
    expect(reply).toContain("data: first");
    expect(reply).not.toContain("data: second");
    for (let i = 0; i < 100 && !reply.includes("data: second"); i++) await Bun.sleep(20);
    expect(reply).toContain("data: second");
  } finally {
    client?.end();
    await lease?.close();
    target.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("public web refuses an origin outside the session policy before DNS", async () => {
  const root = await fixtureRoot("opw-", process.platform === "darwin" ? "/tmp" : undefined);
  let resolved = 0;
  let origins = ["https://allowed.example"];
  let lease: Awaited<ReturnType<typeof openPublicWebLease>> | undefined;
  try {
    lease = await openPublicWebLease({ parentDirectory: root, origins: () => origins,
      resolveHost: async () => { resolved++; return ["8.8.8.8"]; },
    });
    const blocked = await throughProxy(lease.socketPath,
      "CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example:443\r\n\r\n");
    expect(blocked.reply).toContain("403 Forbidden");
    const blockedPort = await throughProxy(lease.socketPath,
      "CONNECT allowed.example:8443 HTTP/1.1\r\nHost: allowed.example:8443\r\n\r\n");
    expect(blockedPort.reply).toContain("403 Forbidden");
    const blockedPlain = await throughProxy(lease.socketPath,
      "GET http://blocked.example/ HTTP/1.1\r\nHost: blocked.example\r\n\r\n");
    expect(blockedPlain.reply).toContain("403 Forbidden");
    expect(resolved).toBe(0);
    origins = [];
    const narrowed = await throughProxy(lease.socketPath,
      "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n");
    expect(narrowed.reply).toContain("403 Forbidden");
    expect(resolved).toBe(0);
    expect(lease.refused()).toEqual(["blocked.example:443", "allowed.example:8443", "blocked.example", "allowed.example:443"]);
  } finally { await lease?.close(); await rm(root, { recursive: true, force: true }); }
});

test("public web lease refuses local, private, reserved and host interface destinations", async () => {
  const root = await fixtureRoot("opw-", process.platform === "darwin" ? "/tmp" : undefined);
  const loopback = [127, 0, 0, 1].join(".");
  let answer = loopback, dialed = 0;
  let lease: Awaited<ReturnType<typeof openPublicWebLease>> | undefined;
  try {
    lease = await openPublicWebLease({ parentDirectory: root, origins: ["https://public.example"],
      resolveHost: async () => [answer],
      routeForTest: (address, port) => { dialed++; return { address, port }; },
    });
    for (answer of [[127, 0, 0, 1], [10, 0, 0, 1], [100, 64, 0, 1], [169, 254, 1, 1],
      [172, 16, 0, 1], [192, 168, 1, 1]].map(octets => octets.join(".")).concat(["::1", "fc00::1", "fe80::1", `::ffff:${loopback}`,
      "2001:" + "db8::1"])) {
      const result = await throughProxy(lease.socketPath,
        "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n");
      expect(result.reply).toContain("403");
    }
    for (const details of Object.values(networkInterfaces()))
      for (const entry of details ?? []) {
        answer = entry.address.split("%")[0] ?? "";
        const result = await throughProxy(lease.socketPath,
          "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n");
        expect(result.reply).toContain("403");
      }
    for (const authority of [loopback + ":443", [10, 0, 0, 1].join(".") + ":443", "[::1]:443", "localhost:443"]) {
      const result = await throughProxy(lease.socketPath,
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      expect(result.reply).toContain("403");
    }
    const plain = await throughProxy(lease.socketPath,
      `GET http://${loopback}/ HTTP/1.1\r\nHost: ${loopback}\r\n\r\n`);
    expect(plain.reply).toContain("403");
    answer = "8.8.8.8";
    for (const request of [
      "CONNECT public.example:443 HTTP/1.1\r\nHost: other.example:443\r\n\r\n",
      "CONNECT public.example:0 HTTP/1.1\r\nHost: public.example:0\r\n\r\n",
      "CONNECT public.example:65536 HTTP/1.1\r\nHost: public.example:65536\r\n\r\n",
      "GET http://public.example:0/ HTTP/1.1\r\nHost: public.example:0\r\n\r\n",
    ]) expect((await throughProxy(lease.socketPath, request)).reply).toContain("403");
    expect(dialed).toBe(0);
    expect(lease.refused()).toContain("public.example:443");
  } finally { await lease?.close(); await rm(root, { recursive: true, force: true }); }
});

needsSymlink("lease ownership fixture checks a linked parent directory")("public web lease owns only its generated directory and closes an active CONNECT tunnel", async () => {
  const root = await fixtureRoot("opw-", process.platform === "darwin" ? "/tmp" : undefined);
  const loopback = [127, 0, 0, 1].join(".");
  const existing = join(root, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "keep"), "untouched");
  await symlink(existing, join(root, "existing-link"));
  let reached = 0;
  const target = listen<undefined>({ hostname: loopback, port: 0, socket: {
    open(socket) { reached++; socket.write("tunnel-ready"); },
    data: () => {}, close: () => {},
  } });
  let lease: Awaited<ReturnType<typeof openPublicWebLease>> | undefined;
  let client: Awaited<ReturnType<typeof connect<undefined>>> | undefined;
  try {
    lease = await openPublicWebLease({ parentDirectory: join(root, "existing-link"),
      origins: ["https://public.example:8443"],
      resolveHost: async () => ["8.8.8.8"],
      routeForTest: (address, port) => {
        expect(address).toBe("8.8.8.8");
        expect(port).toBe(8443);
        return { address: loopback, port: target.port };
      },
    });
    let reply = "";
    client = await connect<undefined>({ unix: lease.socketPath, socket: {
      data: (_socket, chunk) => { reply += new TextDecoder().decode(chunk); },
      close: () => {}, error: () => {},
    } });
    client.write("CONNECT public.example:8443 HTTP/1.1\r\nHost: public.example:8443\r\n\r\n");
    for (let i = 0; i < 100 && !reply.includes("tunnel-ready"); i++) await Bun.sleep(20);
    expect(reply).toContain("200 Connection Established");
    expect(reply).toContain("tunnel-ready");
    expect(reached).toBe(1);
    const firstClose = lease.close();
    expect(lease.close()).toBe(firstClose);
    await firstClose;
    await expect(stat(lease.socketPath)).rejects.toThrow();
    expect((await stat(join(existing, "keep"))).isFile()).toBe(true);
    expect((await stat(join(root, "existing-link", "keep"))).isFile()).toBe(true);
    expect(await readdir(existing)).toEqual(["keep"]);
    lease = undefined;
  } finally {
    client?.end();
    await lease?.close();
    target.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test.if(confinable)("a confined browser cannot dial a host Unix socket but can dial its lease", async () => {
  const root = await fixtureRoot("orbit-egress-unix-");
  const hostSocket = join(root, "host.sock");
  const busSocket = join(root, "private-bus.sock");
  await mkdir(join(root, "profile"));
  const host = listen<undefined>({ unix: hostSocket, socket: { open: socket => { socket.end(); }, data: () => {}, close: () => {} } });
  const bus = listen<undefined>({ unix: busSocket, socket: { open: socket => { socket.end(); }, data: () => {}, close: () => {} } });
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  try {
    lease = await openEgressLease({
      directory: join(root, "egress"), executable: "/usr/bin/python3",
      profile: join(root, "profile"), sessionBus: `unix:path=${busSocket},guid=test`,
      confinable: true, origins: () => ["https://example.test"],
    });
    expect(lease.tier).toBe("namespace");
    const script = [
      "import os, socket, sys",
      "def can_connect(path):",
      "    connection = socket.socket(socket.AF_UNIX)",
      "    try:",
      "        connection.connect(path)",
      "        return True",
      "    except OSError:",
      "        return False",
      "    finally:",
      "        connection.close()",
      "def can_write(path):",
      "    try:",
      "        with open(path, 'a') as file:",
      "            file.write('\\n# probe\\n')",
      "        return True",
      "    except OSError:",
      "        return False",
      "def can_unlink(path):",
      "    try:",
      "        os.unlink(path)",
      "        return True",
      "    except OSError:",
      "        return False",
      "print(f'host={can_connect(sys.argv[1])} lease={can_connect(sys.argv[2])} bus={can_connect(sys.argv[3])} wrapper={can_write(sys.argv[4])} cdp_unlink={can_unlink(sys.argv[5])}')",
    ].join("\n");
    const child = Bun.spawn([lease.launch.executable, "-c", script, hostSocket, join(root, "egress", "lease.sock"), busSocket,
      lease.launch.executable, join(root, "egress", "cdp.sock")], {
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
    expect(output.trim()).toBe("host=False lease=True bus=True wrapper=False cdp_unlink=False");
    await lease.close();
    lease = undefined;
    await expect(stat(join(root, "egress-host"))).rejects.toThrow();
  } finally {
    await lease?.close();
    host.stop(true);
    bus.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test.if(confinable)("a replaced CDP socket name never makes the host dial another Unix service", async () => {
  const root = await fixtureRoot("orbit-egress-cdp-symlink-");
  const hostSocket = join(root, "host.sock");
  let hostConnections = 0;
  const host = listen<undefined>({ unix: hostSocket, socket: {
    open(socket) { hostConnections++; socket.end(); }, data: () => {}, close: () => {},
  } });
  let lease: Awaited<ReturnType<typeof openEgressLease>> | undefined;
  try {
    lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/python3",
      profile: join(root, "profile"), confinable: true, origins: () => ["https://example.test"] });
    expect(lease.tier).toBe("namespace");
    const cdpSocket = join(root, "egress", "cdp.sock");
    await rm(cdpSocket);
    await symlink(hostSocket, cdpSocket);
    const client = await connect<undefined>({ hostname: "127.0.0.1", port: lease.endpointPort,
      socket: { data: () => {}, close: () => {}, error: () => {} } });
    await Bun.sleep(150);
    client.end();
    expect(hostConnections).toBe(0);
  } finally {
    await lease?.close();
    host.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test.if(confinable)("a home-installed browser fails closed when its files cannot be mounted safely", async () => {
  const root = await fixtureRoot("orbit-egress-home-install-");
  try {
    await expect(openEgressLease({
      directory: join(root, "egress"), executable: import.meta.path,
      profile: join(root, "profile"), confinable: true, origins: () => ["https://example.test"],
    })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(stat(join(root, "egress"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.if(confinable)("a failed cloned session removes its account copy and closes its helper", async () => {
  const root = await createWorkspaceDirectory("egress-clone-cleanup-test");
  const platform = await detectPlatform();
  try {
    for (const scenario of [
      { name: "home executable", executable: import.meta.path, confinedEgress: true },
      { name: "missing private bus", executable: "/usr/bin/python3", sessionBus: "unix:path=/tmp/orbit-missing-private-bus", confinedEgress: true },
      { name: "namespace unavailable", executable: "/usr/bin/python3", confinedEgress: false },
    ]) {
      const caseRoot = await mkdtemp(join(root, "case-"));
      let helperClosed = 0;
      class FixtureSessions extends Sessions {
        protected override cloneProfileForSession = async (_source: string, profile: string): Promise<CloneResult> => {
          await writeFile(join(profile, "synthetic-account.json"), "fixture", { mode: 0o600 });
          return { sourceProfile: "fixture", reflinked: false, readOnly: [],
            launch: { executable: scenario.executable, ...(scenario.sessionBus ? { sessionBus: scenario.sessionBus } : {}) },
            close: async () => { helperClosed++; } };
        };
        protected override capabilities() { return Promise.resolve({ ...platform, confinedEgress: scenario.confinedEgress }); }
      }
      const sessions = new FixtureSessions(caseRoot, join(caseRoot, "accounts"));
      try {
        await expect(sessions.create({ backend: "browser", cloneOf: "fixture",
          policy: { mode: "autonomous", origins: ["https://example.test"], allow: ["read", "navigate", "write"] },
        })).rejects.toMatchObject({ code: "UNSUPPORTED" });
        expect(helperClosed).toBe(1);
        expect((await readdir(caseRoot)).filter(entry => entry.startsWith("profile-"))).toEqual([]);
      } finally { await sessions.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test.if(confinable)("a bounded saved account refuses a host without namespace confinement", async () => {
  const root = await createWorkspaceDirectory("egress-account-gate-test");
  const accounts = join(root, "accounts");
  const platform = await detectPlatform();
  class NoNamespaceSessions extends Sessions {
    protected override capabilities() { return Promise.resolve({ ...platform, confinedEgress: false }); }
  }
  const sessions = new NoNamespaceSessions(root, accounts);
  try {
    await expect(sessions.create({ backend: "browser", accountName: "fixture",
      policy: { mode: "autonomous", origins: ["https://example.test"], allow: ["read", "navigate", "write"] },
    })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect((await readdir(root)).filter(entry => entry.startsWith("profile-"))).toEqual([]);
    const account = await AccountLease.acquire(accounts, "fixture");
    await account.release();
  } finally { await sessions.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test.if(confinable)("a failure after browser startup closes the backend, profile and saved account lease", async () => {
  const root = await createWorkspaceDirectory("egress-post-start-cleanup-test");
  const accounts = join(root, "accounts");
  await writeFile(join(root, "journals"), "fixture", { mode: 0o600 });
  const sessions = new Sessions(root, accounts);
  try {
    await expect(sessions.create({ backend: "browser", accountName: "fixture",
      policy: { mode: "autonomous", origins: ["https://example.test"], allow: ["read", "navigate", "write"] },
    })).rejects.toThrow();
    expect((await readdir(root)).filter(entry => entry.startsWith("profile-"))).toEqual([]);
    const account = await AccountLease.acquire(accounts, "fixture");
    await account.release();
  } finally { await sessions.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test.if(confinable)("a leased session browses through a network of its own, and an unleased origin is unreachable", async () => {
  const workspace = await createWorkspaceDirectory("egress-session-test");
  const sessions = new Sessions(workspace);
  let leasedHits = 0, unleasedHits = 0;
  const unleased = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unleasedHits++; return new Response("<output>unleased</output>", { headers: { "Content-Type": "text/html" } }); } });
  // The leased page reaches for the unleased origin itself. No agent action asks for that, which is
  // the whole reason a lease exists below the agent as well as in front of it.
  const leased = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    leasedHits++;
    return new Response(`<output>leased page</output><script>fetch("http://127.0.0.1:${unleased.port}/from-the-page", { mode: "no-cors" }).catch(() => {})</script>`,
      { headers: { "Content-Type": "text/html" } });
  } });
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  try {
    const created = await run("session.create", {
      backend: "browser", agentName: "egress-test", taskName: "confined session",
      policy: { mode: "autonomous", origins: [`http://127.0.0.1:${leased.port}`], allow: ["read", "navigate", "write"] },
    }) as { sessionId: string; egressTier: string };
    const leaseDirectory = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "sbar-orbit", "egress", created.sessionId.slice(0, 8));
    // The browser was given no network of its own on a host that can do that.
    expect(created.egressTier).toBe("namespace");

    const act = (action: unknown) => run("session.act", { sessionId: created.sessionId, requestId: crypto.randomUUID(), action });
    await act({ type: "navigate", url: `http://127.0.0.1:${leased.port}/` });
    // A confined session that cannot browse is not confined, it is broken.
    expect(await act({ type: "read", selector: "output" })).toEqual({ text: "leased page" });
    expect(leasedHits).toBeGreaterThan(0);

    // The agent is refused by the policy before the browser is asked, which is the layer above.
    await expect(act({ type: "navigate", url: `http://127.0.0.1:${unleased.port}/` })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // And what the page reached for on its own never arrived. Both layers hold this: which one held it
    // first is isolated in `experiments/confined-egress.ts`, where the browser is confined and the
    // interception is not installed at all.
    await Bun.sleep(500);
    expect(unleasedHits).toBe(0);
    const blocked = await run("session.journal", { sessionId: created.sessionId }) as { blockedOrigins: string[] };
    expect(blocked.blockedOrigins).toContain(`http://127.0.0.1:${unleased.port}`);

    const journal = await run("session.journal", { sessionId: created.sessionId }) as { entries: { reason?: string }[]; egressTier: string; refusedAuthorities: string[] };
    // The first line says what was agreed to, including which layer held the lease, because a reader
    // of an autonomous run cannot otherwise tell a confined session from an unconfined one.
    expect(journal.entries[0]?.reason).toContain("network namespace of its own");
    expect(journal.egressTier).toBe("namespace");
    // Chrome reaches for its own services on startup, and on this path those are refused like anything
    // else, so the lease has something to report rather than nothing.
    expect(Array.isArray(journal.refusedAuthorities)).toBe(true);

    // The route out exists while the session does.
    await expect(stat(leaseDirectory)).resolves.toBeTruthy();
    await run("session.stop", { sessionId: created.sessionId });
    // And nothing of it survives the session it belonged to: the proxy, the relay, the wrapper and the
    // sockets go together, because each one is a way into a browser holding real logins.
    await expect(stat(leaseDirectory)).rejects.toThrow();
  } finally { await sessions.close(); leased.stop(true); unleased.stop(true); }
}, 60000);

test("an unbounded session is left exactly as it was, because there is nothing to enforce", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("egress-any-test"));
  try {
    // A fresh profile session names no origins, and a namespace whose proxy forwards everything would
    // add a hop and no boundary. This is also what keeps every session measured before this change on
    // the path it was measured on.
    const created = await sessions.dispatch({ method: "session.create", params: { backend: "browser" } }) as { sessionId: string; egressTier: string };
    expect(created.egressTier).toBe("in-browser");
    const journal = await sessions.dispatch({ method: "session.journal", params: { sessionId: created.sessionId } }) as { entries: { reason?: string }[] };
    expect(journal.entries[0]?.reason).not.toContain("egress held");
  } finally { await sessions.close(); }
}, 30000);
