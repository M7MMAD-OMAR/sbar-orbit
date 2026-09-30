import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { BlockList, connect as netConnect, createServer as createNetServer, isIP, type Server as NetServer, type Socket as NetSocket } from "node:net";
import { networkInterfaces } from "node:os";
import { isAbsolute, join } from "node:path";
import { OrbitError } from "./errors";

/**
 * The origin lease, held below the browser instead of inside it.
 *
 * Request interception in `browser.ts` already holds every route a page initiates, measured against
 * eleven of them including a service worker and a WebSocket. It holds them inside the browser, which
 * is the right place for a page that is merely following instructions and the wrong place for a
 * browser that is not doing what it is told. Orbit runs Chrome with `--no-sandbox`, so that is not a
 * hypothetical distinction, and `--proxy-server` is a browser setting the browser agreed to honour:
 * measured, a confined browser with that setting removed reaches nothing, and an unconfined one
 * reaches everything.
 *
 * So a leased session gets a browser with no network of its own. Its only route out is a unix socket
 * into this file, which forwards the authorities the lease names and refuses the rest.
 *
 * Two layers at two resolutions, and the difference is worth naming rather than hiding:
 *   in the browser   per origin, and a document's redirect target is checked a hop at a time.
 *   below it         per authority, because CONNECT tells a proxy `host:port` and nothing else.
 * Neither replaces the other. The inner one knows the scheme and the path; the outer one is the only
 * one a misbehaving renderer cannot talk its way past. CONNECT does not prove TLS SNI or the HTTP
 * origin inside its encrypted stream.
 */

export type EgressTier =
  /** The browser has no network of its own. Its only route out is the lease. */
  | "namespace"
  /** The host cannot confine a browser, so the lease is the request interception inside it. */
  | "in-browser";

export type EgressLease = {
  tier: EgressTier;
  /** What to run instead of the browser, and the settings that send it through the lease. */
  launch: { executable: string; args: string[] };
  /**
   * Where CDP is really reachable. Inside the namespace the browser owns its own loopback, so the
   * port it writes into DevToolsActivePort is not a port on this machine.
   */
  endpointPort: number;
  /** Authorities the page reached for and the lease refused, deduplicated, newest last. */
  refused: () => string[];
  close: () => Promise<void>;
};

/**
 * Where the browser finds the proxy. Fixed, because inside its own network namespace it is the only
 * thing on that loopback and so collides with nothing, whatever the other thirty sessions are doing.
 */
const CONFINED_PROXY_PORT = 8888;

/** `https://example.com` reaches `example.com:443`. The default port is implied and CONNECT is not. */
export function leasedAuthorities(origins: string[]): string[] {
  return [...new Set(origins.flatMap(origin => {
    let url: URL;
    try { url = new URL(origin); } catch { return []; }
    const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    return port ? [`${url.hostname}:${port}`] : [];
  }))];
}

type StreamListener = { port: number; stop: (force?: boolean) => void };

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left); joined.set(right, left.length);
  return joined;
}

/**
 * A forward proxy on a unix socket, speaking only as much HTTP as a proxy has to.
 *
 * It is deliberately not written on Bun.serve: Bun.serve cannot answer CONNECT, and CONNECT is the
 * only thing a real session uses, since every origin worth leasing is https. The experiment that
 * measured this mechanism used plain HTTP fixtures and therefore proved nothing about the transport
 * that matters, which is why this is bytes on a socket rather than a request handler.
 */
const nonPublicV4 = new BlockList();
for (const [a, b, c, d, prefix] of [
  [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16], [172, 16, 0, 0, 12], [192, 0, 0, 0, 24],
  [192, 0, 2, 0, 24], [192, 168, 0, 0, 16], [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24], [203, 0, 113, 0, 24], [224, 0, 0, 0, 3],
] as const) nonPublicV4.addSubnet([a, b, c, d].join("."), prefix, "ipv4");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const nonPublicV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) nonPublicV6.addSubnet(address, prefix, "ipv6");
const loopbackV4 = new BlockList();
loopbackV4.addSubnet("127.0.0.0", 8, "ipv4");

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublicV4.check(address, "ipv4");
  if (family === 6) return publicV6.check(address, "ipv6") && !nonPublicV6.check(address, "ipv6");
  return false;
}

function loopbackAddress(address: string): boolean {
  return isIP(address) === 4 ? loopbackV4.check(address, "ipv4") : address === "::1";
}

function hostInterfaceAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  const interfaces = new BlockList();
  for (const details of Object.values(networkInterfaces()))
    for (const entry of details ?? []) {
      const candidate = entry.address.split("%")[0] ?? "";
      const entryFamily = isIP(candidate);
      if (!entryFamily) continue;
      try { interfaces.addAddress(candidate, entryFamily === 4 ? "ipv4" : "ipv6"); }
      catch { return true; }
    }
  try { return interfaces.check(address, family === 4 ? "ipv4" : "ipv6"); }
  catch { return true; }
}

async function systemResolveHost(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(answer => answer.address);
}

async function resolveWithin(hostname: string, resolver: (hostname: string) => Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => resolver(hostname)),
      new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), 5000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function matchingHttpHost(headers: string, url: URL): boolean {
  const lines = headers.split("\r\n");
  if (lines.some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(line))) return false;
  const hosts = lines.filter(line => /^host:/i.test(line));
  if (hosts.length !== 1) return false;
  const host = hosts[0]?.slice(5).trim() ?? "";
  if (!host || /[\s\\/@?#%,]/.test(host)) return false;
  try { return new URL(`http://${host}/`).origin === url.origin; }
  catch { return false; }
}

function matchingRequestHost(request: IncomingMessage, url: URL): boolean {
  const hosts: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === "host") hosts.push(request.rawHeaders[index + 1] ?? "");
  if (hosts.length !== 1) return false;
  const host = hosts[0]?.trim() ?? "";
  if (!host || /[\s\\/@?#%,]/.test(host)) return false;
  try { return new URL(`http://${host}/`).origin === url.origin; }
  catch { return false; }
}

async function publicCandidates(hostname: string, resolveHost: (hostname: string) => Promise<string[]>): Promise<string[]> {
  const name = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const lower = name.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost") || name.includes("%")) return [];
  const addresses = isIP(name) ? [name] : await resolveWithin(name, resolveHost).catch(() => []);
  return [...new Set(addresses.filter(address => publicAddress(address) && !hostInterfaceAddress(address)))];
}

/**
 * A public web route for a native browser whose own network namespace has no external interface.
 * Its only host connection is this Unix socket. HTTP requests are parsed individually, including
 * persistent connections and request bodies; CONNECT remains a blind tunnel at host:port resolution.
 * This is an authority filter for HTTPS and an origin filter for plain HTTP. CONNECT cannot inspect
 * the encrypted request inside its tunnel or prove its TLS peer identity.
 */
export type PublicWebLease = {
  socketPath: string;
  refused: () => string[];
  close: () => Promise<void>;
};

export type PublicWebLeaseRequest = {
  /** An existing private directory. The lease creates and owns a fresh child within it. */
  parentDirectory: string;
  /** The exact origins admitted by the session policy. */
  origins: string[] | (() => string[]);
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Fixture seam. Production leaves the checked numeric address and port unchanged. */
  routeForTest?: (checkedAddress: string, port: number) => { address: string; port: number };
};

export async function openPublicWebLease(request: PublicWebLeaseRequest): Promise<PublicWebLease> {
  const permitted = () => {
    const origins = new Set((typeof request.origins === "function" ? request.origins() : request.origins)
      .map(origin => new URL(origin).origin));
    return { origins, authorities: new Set(leasedAuthorities([...origins])) };
  };
  if (!permitted().authorities.size)
    throw new OrbitError("INVALID_REQUEST", "Zen public web needs at least one bounded origin");
  const parent = await realpath(request.parentDirectory);
  const directory = await mkdtemp(join(parent, "public-web-"));
  const socketPath = join(directory, "lease.sock");
  if (socketPath.length > 100) {
    await rm(directory, { recursive: true, force: true });
    throw new OrbitError("UNSUPPORTED", "Public web lease Unix socket path is too long");
  }
  const resolveHost = request.resolveHost ?? systemResolveHost;
  const route = request.routeForTest ?? ((address: string, port: number) => ({ address, port }));
  const refused: string[] = [];
  const sockets = new Set<NetSocket>();
  let active = true;
  let closing: Promise<void> | undefined;
  const refuse = (authority: string) => { if (!refused.includes(authority)) refused.push(authority); };
  const track = (socket: NetSocket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
    return socket;
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      let url: URL;
      try { url = new URL(incoming.url ?? ""); }
      catch { url = new URL("about:blank"); }
      if (url.protocol !== "http:" || url.username || url.password || !matchingRequestHost(incoming, url) ||
          !permitted().origins.has(url.origin)) {
        refuse(url.host || "(unparseable)");
        outgoing.writeHead(403, { "Content-Length": "0", Connection: "close" });
        outgoing.end();
        return;
      }
      const candidates = await publicCandidates(url.hostname, resolveHost);
      const pinned = candidates[0];
      if (!active || !pinned) {
        refuse(url.host);
        outgoing.writeHead(403, { "Content-Length": "0", Connection: "close" });
        outgoing.end();
        return;
      }
      const port = Number(url.port || 80);
      if (port < 1 || port > 65535) {
        refuse(url.host);
        outgoing.writeHead(403, { "Content-Length": "0", Connection: "close" });
        outgoing.end();
        return;
      }
      const target = route(pinned, port);
      const headers: IncomingHttpHeaders = { ...incoming.headers, host: url.host };
      delete headers.connection;
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      const upstream = httpRequest({ hostname: target.address, port: target.port,
        method: incoming.method, path: `${url.pathname}${url.search}`, headers, agent: false,
      }, response => {
        const responseHeaders: IncomingHttpHeaders = { ...response.headers };
        delete responseHeaders.connection;
        delete responseHeaders["proxy-connection"];
        delete responseHeaders["keep-alive"];
        delete responseHeaders["transfer-encoding"];
        outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
        response.pipe(outgoing);
      });
      upstream.on("socket", track);
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { "Content-Length": "0", Connection: "close" });
        outgoing.end();
      });
      incoming.pipe(upstream);
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "Content-Length": "0", Connection: "close" });
      outgoing.end();
    });
  });
  server.on("connection", track);
  server.on("upgrade", (_request, socket) => { socket.destroy(); });
  server.on("connect", (incoming, client, head) => {
    void (async () => {
      let url: URL;
      try { url = new URL(`http://${incoming.url}/`); }
      catch { url = new URL("about:blank"); }
      const authority = incoming.url ?? "(unparseable)";
      const match = /^(?:\[[^\]]+\]|[^:/?#@\s]+):([0-9]+)$/.exec(authority);
      const port = Number(match?.[1] ?? 0);
      if (!match || port < 1 || port > 65535 || url.username || url.password || url.pathname !== "/" ||
          !matchingRequestHost(incoming, url) || !permitted().authorities.has(`${url.hostname}:${port}`)) {
        refuse(authority);
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const candidates = await publicCandidates(url.hostname, resolveHost);
      const pinned = candidates[0];
      if (!active || !pinned) {
        refuse(authority);
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const target = route(pinned, port);
      const upstream = track(netConnect({ host: target.address, port: target.port }));
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
      client.once("close", () => { upstream.destroy(); });
    })().catch(() => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    active = false;
    for (const socket of sockets) socket.destroy();
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { socketPath, refused: () => [...refused], close: () => {
    if (!closing) {
      active = false;
      closing = (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      })();
    }
    return closing;
  } };
}

function trackStream(sockets: Set<NetSocket>, socket: NetSocket): NetSocket {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

async function bindStreams(server: NetServer, endpoint: string | { host: string; port: number }, sockets: Set<NetSocket>): Promise<StreamListener> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const ready = () => { server.off("error", reject); resolve(); };
    if (typeof endpoint === "string") server.listen(endpoint, ready);
    else server.listen(endpoint.port, endpoint.host, ready);
  });
  const address = server.address();
  let stopped = false;
  return { port: address && typeof address !== "string" ? address.port : 0, stop: (force = false) => {
    if (force) for (const socket of sockets) socket.destroy();
    if (!stopped) { stopped = true; server.close(); }
  } };
}

async function startProxy(path: string, origins: () => string[], onRefused: (authority: string) => void,
  resolveHost: (hostname: string) => Promise<string[]>): Promise<StreamListener> {
  const sockets = new Set<NetSocket>();
  const refuse = (client: NetSocket, authority: string) => {
    onRefused(authority);
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  };
  const pipeTo = (client: NetSocket, host: string, port: number, authority: string,
    first: Uint8Array, announce?: string) => {
    // Pausing the reader keeps bytes in the socket until the checked destination
    // connects. Stream piping preserves partial writes and propagates backpressure.
    client.pause();
    void (async () => {
      const name = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      const addresses = isIP(name) ? [name] : await resolveWithin(name, resolveHost).catch(() => []);
      const candidates = [...new Set(isIP(name) ? [name] : name === "localhost"
        ? addresses.filter(loopbackAddress) : addresses.filter(address => publicAddress(address) && !hostInterfaceAddress(address)))];
      if (!candidates.length) return refuse(client, authority);
      const attempt = (index: number): void => {
        if (client.destroyed) return;
        const pinned = candidates[index];
        if (!pinned) { client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
        const upstream = trackStream(sockets, netConnect({ host: pinned, port, allowHalfOpen: true }));
        let connected = false;
        upstream.setTimeout(5000, () => upstream.destroy(new Error("Proxy connect deadline")));
        upstream.once("connect", () => {
          if (client.destroyed) { upstream.destroy(); return; }
          connected = true;
          upstream.setTimeout(0);
          if (announce) client.write(announce);
          if (first.length) upstream.write(first);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume(); upstream.resume();
        });
        upstream.once("error", () => { if (!connected) attempt(index + 1); else client.destroy(); });
        client.once("close", () => upstream.destroy());
      };
      attempt(0);
    })().catch(() => { if (!client.destroyed) refuse(client, authority); });
  };
  const server = createNetServer({ allowHalfOpen: true }, client => {
    trackStream(sockets, client);
    client.on("error", () => client.destroy());
    let buffer: Uint8Array = new Uint8Array(0);
    const header = (chunk: Buffer) => {
      buffer = append(buffer, chunk);
      const text = new TextDecoder().decode(buffer);
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd < 0) { if (buffer.length > 65536) client.destroy(); return; }
      client.off("data", header);
      client.pause();
      const headerBlock = text.slice(0, headerEnd + 4);
      if (/(^|[^\r])\n|\r(?!\n)/.test(headerBlock)) return refuse(client, "(malformed headers)");
      const [requestLine = ""] = text.split("\r\n");
      const [method = "", target = ""] = requestLine.split(" ");
      const allowed = origins();
      if (method === "CONNECT") {
        const authority = target.includes(":") ? target : `${target}:443`;
        if (!leasedAuthorities(allowed).includes(authority)) return refuse(client, authority);
        let endpoint: URL;
        try { endpoint = new URL(`http://${authority}/`); } catch { return refuse(client, "(unparseable)"); }
        return pipeTo(client, endpoint.hostname, Number(endpoint.port || 80), authority,
          buffer.slice(headerEnd + 4), "HTTP/1.1 200 Connection Established\r\n\r\n");
      }
      let url: URL;
      try { url = new URL(target); } catch { return refuse(client, "(unparseable)"); }
      if (url.protocol !== "http:" || url.username || url.password || !allowed.includes(url.origin)) return refuse(client, url.host);
      const headers = text.slice(requestLine.length + 2, headerEnd);
      if (!matchingHttpHost(headers, url)) return refuse(client, url.host);
      return pipeTo(client, url.hostname, Number(url.port || 80), url.host, buffer);
    };
    client.on("data", header);
  });
  return bindStreams(server, path, sockets);
}

/**
 * The host owns both listeners. The browser connects out to the Unix listener,
 * so replacing a pathname in the private profile cannot redirect the host.
 * Bounded early buffers preserve the handshake; stream pipes retain write tails.
 */
async function startCdpRelay(socketPath: string): Promise<{ local: StreamListener; browser: StreamListener }> {
  const waitingLocal: NetSocket[] = [];
  const waitingBrowser: NetSocket[] = [];
  const localSockets = new Set<NetSocket>();
  const browserSockets = new Set<NetSocket>();
  const peers = new Map<NetSocket, NetSocket>();
  const earlyBuffers = new Map<NetSocket, Uint8Array>();
  const earlyReaders = new Map<NetSocket, (chunk: Buffer) => void>();
  const pair = (local: NetSocket, browser: NetSocket) => {
    peers.set(local, browser); peers.set(browser, local);
    for (const socket of [local, browser]) {
      const reader = earlyReaders.get(socket);
      if (reader) socket.off("data", reader);
      const buffer = earlyBuffers.get(socket);
      if (buffer?.length) peers.get(socket)?.write(buffer);
      earlyReaders.delete(socket); earlyBuffers.delete(socket);
    }
    local.pipe(browser); browser.pipe(local);
    local.resume(); browser.resume();
  };
  const opened = (socket: NetSocket, mine: NetSocket[], other: NetSocket[], sockets: Set<NetSocket>, fromBrowser: boolean) => {
    trackStream(sockets, socket);
    const early = (chunk: Buffer) => {
      const buffer = append(earlyBuffers.get(socket) ?? new Uint8Array(0), chunk);
      if (buffer.length > 65536) socket.destroy();
      else earlyBuffers.set(socket, buffer);
    };
    earlyReaders.set(socket, early);
    socket.on("data", early);
    let timer: ReturnType<typeof setTimeout> | undefined;
    socket.once("close", () => {
      if (timer !== undefined) clearTimeout(timer);
      earlyReaders.delete(socket); earlyBuffers.delete(socket);
      const index = mine.indexOf(socket);
      if (index >= 0) mine.splice(index, 1);
      const peer = peers.get(socket);
      peers.delete(socket);
      if (peer) { peers.delete(peer); peer.end(); }
    });
    socket.once("error", () => { peers.get(socket)?.destroy(); socket.destroy(); });
    let peer: NetSocket | undefined;
    while ((peer = other.shift())) {
      if (!peer.destroyed) { fromBrowser ? pair(peer, socket) : pair(socket, peer); return; }
    }
    if (mine.length >= 8) { socket.end(); return; }
    mine.push(socket);
    if (!fromBrowser) {
      timer = setTimeout(() => { if (!peers.has(socket) && !socket.destroyed) socket.end(); }, 10000);
      timer.unref();
    }
  };
  const browserServer = createNetServer({ allowHalfOpen: true }, socket => opened(socket, waitingBrowser, waitingLocal, browserSockets, true));
  const browser = await bindStreams(browserServer, socketPath, browserSockets);
  try {
    const localServer = createNetServer({ allowHalfOpen: true }, socket => opened(socket, waitingLocal, waitingBrowser, localSockets, false));
    const local = await bindStreams(localServer, { host: "127.0.0.1", port: 0 }, localSockets);
    return { local, browser };
  } catch (error) { browser.stop(true); throw error; }
}

/**
 * The wrapper the supervisor runs instead of the browser.
 *
 * Two things here were measured rather than assumed.
 *
 * `--unshare-pid` is not tidiness. Without it the relays inside are orphaned when the browser exits,
 * reparent to init on the host, and hold the network namespace open after the session that owned it is
 * gone. With it the sandbox has an init of its own and everything in it goes when the browser does. It
 * also costs the browser its escape route: inside a pid namespace its attempt to move itself into a
 * systemd scope of its own is refused, which is a boundary Orbit otherwise has to remove a bus to keep.
 *
 * The debugging port is discovered from inside rather than fixed. Chrome writes DevToolsActivePort only
 * when it chose the port itself: measured on Chrome 141, an explicit `--remote-debugging-port=9222`
 * listens and writes no file at all, and only `=0` publishes one. So a fixed port would have been
 * simpler and would have left the launcher with no way to learn the path half of the endpoint.
 */
function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function busSocketPath(address?: string): string | undefined {
  if (!address) return undefined;
  const match = /^unix:path=([^,;]+)/.exec(address);
  if (!match?.[1]) throw new OrbitError("UNSUPPORTED", "A confined browser needs a filesystem path for its private secret bus");
  let path: string;
  try { path = decodeURIComponent(match[1]); }
  catch { throw new OrbitError("UNSUPPORTED", "The private secret bus has an invalid socket path"); }
  if (!isAbsolute(path) || path.includes("\0"))
    throw new OrbitError("UNSUPPORTED", "The private secret bus needs an absolute socket path");
  return path;
}

async function writeWrapper(directory: string, executable: string, profile: string, proxySocket: string, cdpSocket: string, sessionBus?: string): Promise<string> {
  const resolvedExecutable = await realpath(executable).catch(() => "");
  if (!resolvedExecutable.startsWith("/usr/") && !resolvedExecutable.startsWith("/opt/"))
    throw new OrbitError("UNSUPPORTED", "A confined browser must be installed under /usr or /opt; mounting a home install could expose host sockets");
  const busSocket = busSocketPath(sessionBus);
  if (busSocket && !(await lstat(busSocket).catch(() => undefined))?.isSocket())
    throw new OrbitError("UNSUPPORTED", "The private secret bus socket is unavailable");
  // A read-only bind of / still permits AF_UNIX connect to host sockets. Start with an empty root,
  // expose only system application files, the private profile and this lease, then mount the one
  // private secret bus socket when a cloned profile needs it. A home-installed browser fails closed.
  const sandbox = [
    "/usr/bin/bwrap", "--unshare-net", "--unshare-pid", "--tmpfs", "/",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc",
    "--ro-bind-try", "/opt", "/opt", "--ro-bind-try", "/sys", "/sys",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/var/tmp",
    "--bind", profile, profile, "--ro-bind", proxySocket, proxySocket,
    "--ro-bind", cdpSocket, cdpSocket,
    ...(busSocket ? ["--ro-bind", busSocket, busSocket] : []),
    "--setenv", "HOME", profile, "--setenv", "XDG_CONFIG_HOME", join(profile, "config"),
    "--setenv", "XDG_CACHE_HOME", join(profile, "cache"), "--setenv", "XDG_RUNTIME_DIR", profile,
    "--setenv", "TMPDIR", "/tmp", "--chdir", "/", "--die-with-parent",
  ];
  // Keep the executable wrapper in an unmounted sibling. Mounting it with any writable lease
  // directory would let a browser rewrite it for the next restore or relaunch.
  const wrapperDirectory = `${directory}-host`;
  await mkdir(wrapperDirectory, { mode: 0o700 });
  await chmod(wrapperDirectory, 0o700);
  const wrapper = join(wrapperDirectory, "confined-browser.sh");
  await writeFile(wrapper, `#!/bin/sh
# No host runtime directories enter this mount namespace. Only the lease and optional private bus
# cross it, so a browser cannot use a host Unix socket as an unfiltered route around the proxy.
exec ${sandbox.map(quoteShell).join(" ")} /bin/sh -c '
  proxy_socket=$1
  cdp_socket=$2
  profile=$3
  executable=$4
  shift 4
  /usr/bin/socat TCP-LISTEN:${CONFINED_PROXY_PORT},bind=127.0.0.1,fork,reuseaddr "UNIX-CONNECT:$proxy_socket" &
  (
    attempt=0
    while [ ! -s "$profile/DevToolsActivePort" ] && [ $attempt -lt 600 ]; do
      /usr/bin/sleep 0.05
      attempt=$((attempt + 1))
    done
    port=$(/usr/bin/head -1 "$profile/DevToolsActivePort")
    case "$port" in
      "" | *[!0-9]* ) exit 1 ;;
    esac
    # The host owns this socket. Connect outward instead of asking the host to connect to a path
    # a browser could replace with a symlink. Keep three connections ready for simultaneous CDP use.
    for worker in 1 2 3; do
      (
        while :; do
          /usr/bin/socat "TCP:127.0.0.1:$port" "UNIX-CONNECT:$cdp_socket"
          /usr/bin/sleep 0.05
        done
      ) &
    done
    wait
  ) &
  exec "$executable" "$@"
' confined-browser ${[proxySocket, cdpSocket, profile, executable].map(quoteShell).join(" ")} "$@"
`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

export type EgressLeaseRequest = {
  /**
   * A directory of this lease's own, beside the session profile and never inside it. The profile is a
   * btrfs subvolume that restore points snapshot and that the clone's freeze pass walks, and a live
   * socket belongs in neither.
   */
  directory: string;
  /** The real browser. The wrapper execs this, so the profile is still opened by the install that owns it. */
  executable: string;
  /**
   * The session profile. Read from inside the sandbox, and only to learn which port the browser chose
   * for CDP. Nothing is written there: a live socket inside a profile would end up inside every restore
   * point taken from it.
   */
  profile: string;
  /** The one-item secret bus of a cloned profile, never the person's whole session bus. */
  sessionBus?: string;
  /**
   * Read on every request rather than copied once. `session.narrow` and an immune deny both tighten a
   * running session's policy, and a lease that had taken a snapshot at creation would keep forwarding
   * to an origin the session no longer holds.
   */
  origins: () => string[];
  /** Substitute name resolution in a local proxy fixture without changing system DNS. */
  resolveHost?: (hostname: string) => Promise<string[]>;
};

/**
 * Confine a browser to the origins its session was given, or say plainly that this host cannot.
 *
 * Returns the `in-browser` tier rather than throwing where bubblewrap is unavailable or refused: a
 * session that cannot be confined still runs, with the lease it can actually have, and the tier is
 * recorded so a reader of the journal knows which one held.
 */
export async function openEgressLease(request: EgressLeaseRequest & { confinable: boolean }): Promise<EgressLease> {
  const unconfined: EgressLease = {
    tier: "in-browser", launch: { executable: request.executable, args: [] }, endpointPort: 0,
    refused: () => [], close: async () => {},
  };
  if (!request.confinable) return unconfined;
  // A unix socket path is 108 bytes, kernel side, and over that it is silently truncated: socat binds
  // a shortened path, nothing connects to it, and the session dies waiting for a browser that started
  // fine. Better to drop the tier deliberately, which is recorded, than to truncate quietly.
  if (join(request.directory, "cdp.sock").length > 100) return unconfined;
  await mkdir(request.directory, { recursive: true, mode: 0o700 });
  await chmod(request.directory, 0o700);
  const proxySocket = join(request.directory, "lease.sock");
  const cdpSocket = join(request.directory, "cdp.sock");
  const wrapperDirectory = `${request.directory}-host`;
  const refused: string[] = [];
  let proxy: StreamListener | undefined;
  let relay: Awaited<ReturnType<typeof startCdpRelay>> | undefined;
  try {
    proxy = await startProxy(proxySocket, request.origins, authority => { if (!refused.includes(authority)) refused.push(authority); },
      request.resolveHost ?? systemResolveHost);
    relay = await startCdpRelay(cdpSocket);
    await chmod(proxySocket, 0o600);
    await chmod(cdpSocket, 0o600);
    const wrapper = await writeWrapper(request.directory, request.executable, request.profile, proxySocket, cdpSocket, request.sessionBus);
    const held = { proxy, relay };
    return {
      tier: "namespace",
      launch: {
        executable: wrapper,
        // Chrome bypasses its proxy for loopback by default, and a lease that silently exempts
        // 127.0.0.1 is a lease with a hole in it that only shows up on a host with something
        // listening there. Found by the measurement failing rather than by reading the flag list.
        args: [`--proxy-server=127.0.0.1:${CONFINED_PROXY_PORT}`, "--proxy-bypass-list=<-loopback>"],
      },
      endpointPort: held.relay.local.port,
      refused: () => [...refused],
      close: async () => {
        held.proxy.stop(true); held.relay.local.stop(true); held.relay.browser.stop(true);
        await rm(wrapperDirectory, { recursive: true, force: true }).catch(() => {});
        await rm(request.directory, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    proxy?.stop(true); relay?.local.stop(true); relay?.browser.stop(true);
    await rm(wrapperDirectory, { recursive: true, force: true }).catch(() => {});
    await rm(request.directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof OrbitError) throw error;
    return unconfined;
  }
}
