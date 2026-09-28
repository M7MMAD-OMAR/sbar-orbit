import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { connect, listen, type Socket, type TCPSocketListener, type UnixSocketListener } from "bun";
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
 * one a misbehaving renderer cannot talk its way past.
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

type Pending = { buffer: Uint8Array; upstream?: Socket<unknown>; piping: boolean };
type RelayPending = { buffer: Uint8Array; peer?: Socket<RelayPending>; closed: boolean };

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
function startProxy(path: string, origins: () => string[], onRefused: (authority: string) => void): UnixSocketListener<Pending> {
  const refuse = (client: Socket<Pending>, authority: string) => {
    onRefused(authority);
    client.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    client.end();
  };
  const pipeTo = (client: Socket<Pending>, host: string, port: number, first?: Uint8Array, announce?: string) => {
    client.data.piping = true;
    connect<unknown>({
      hostname: host, port,
      socket: {
        open(upstream) {
          // One upstream per client, for the reason written against the CDP relay below.
          if (client.data.upstream) return void upstream.end();
          client.data.upstream = upstream;
          if (announce) client.write(announce);
          if (first?.length) upstream.write(first);
          // Whatever arrived while the connection was being made.
          if (client.data.buffer.length) { upstream.write(client.data.buffer); client.data.buffer = new Uint8Array(0); }
        },
        data: (_upstream, chunk) => { client.write(chunk); },
        close: () => { client.end(); },
        error: () => { client.end(); },
        connectError: () => {
          // The authority was leased and did not answer. This is not a refusal, so it is not recorded
          // as one: a session that cannot tell the two apart cannot be reviewed afterwards.
          client.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          client.end();
        },
      },
    }).catch(() => { client.end(); });
  };
  return listen<Pending>({
    unix: path,
    socket: {
      open(client) { client.data = { buffer: new Uint8Array(0), piping: false }; },
      data(client, chunk) {
        if (client.data.piping) {
          // Past the first request the connection is a tunnel, and its authority was fixed when it
          // was opened. A second plain HTTP request on the same connection therefore goes to the host
          // the first one named, which is not where a page asking for somewhere else wanted it.
          if (client.data.upstream) client.data.upstream.write(chunk);
          else client.data.buffer = append(client.data.buffer, chunk);
          return;
        }
        client.data.buffer = append(client.data.buffer, chunk);
        const text = new TextDecoder().decode(client.data.buffer);
        const headerEnd = text.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          // A request line that never ends is a request that never gets forwarded.
          if (client.data.buffer.length > 65536) client.end();
          return;
        }
        const [requestLine = ""] = text.split("\r\n");
        const [method = "", target = ""] = requestLine.split(" ");
        const allowed = origins();
        if (method === "CONNECT") {
          const authority = target.includes(":") ? target : `${target}:443`;
          client.data.buffer = client.data.buffer.slice(headerEnd + 4);
          if (!leasedAuthorities(allowed).includes(authority)) return refuse(client, authority);
          const [host = "", port = "443"] = authority.split(":");
          return pipeTo(client, host, Number(port), undefined, "HTTP/1.1 200 Connection Established\r\n\r\n");
        }
        // Plain HTTP arrives as an absolute URI, which carries the scheme, so here the lease is
        // checked at the resolution it was written at rather than by authority.
        let url: URL;
        try { url = new URL(target); } catch { return refuse(client, "(unparseable)"); }
        if (!allowed.includes(url.origin)) return refuse(client, url.host);
        const request = client.data.buffer.slice(0, headerEnd + 4);
        client.data.buffer = client.data.buffer.slice(headerEnd + 4);
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        return pipeTo(client, url.hostname, port, request);
      },
      close(client) { void client.data.upstream?.end(); },
      error(client) { void client.data.upstream?.end(); client.end(); },
    },
  });
}

/**
 * Carry CDP across the namespace boundary without connecting to a name the browser can replace.
 * The host creates the Unix listener first, and a helper inside the namespace connects outward to
 * it after Chrome publishes its debugging port. The host pairs that connection with its local CDP
 * client. Connecting from the host to a socket created in the browser's writable directory allowed
 * a symlink there to redirect the host to an unrelated Unix service.
 */
function startCdpRelay(socketPath: string): { local: TCPSocketListener<RelayPending>; browser: UnixSocketListener<RelayPending> } {
  const waitingLocal: Socket<RelayPending>[] = [];
  const waitingBrowser: Socket<RelayPending>[] = [];
  const pair = (local: Socket<RelayPending>, browser: Socket<RelayPending>) => {
    local.data.peer = browser;
    browser.data.peer = local;
    if (local.data.buffer.length) browser.write(local.data.buffer);
    if (browser.data.buffer.length) local.write(browser.data.buffer);
    local.data.buffer = browser.data.buffer = new Uint8Array(0);
  };
  const opened = (socket: Socket<RelayPending>, mine: Socket<RelayPending>[], other: Socket<RelayPending>[], fromBrowser: boolean) => {
    socket.data = { buffer: new Uint8Array(0), closed: false };
    let peer: Socket<RelayPending> | undefined;
    while ((peer = other.shift())) {
      if (!peer.data.closed) return fromBrowser ? pair(peer, socket) : pair(socket, peer);
    }
    if (mine.length >= 8) return void socket.end();
    mine.push(socket);
    if (!fromBrowser) setTimeout(() => { if (!socket.data.peer && !socket.data.closed) socket.end(); }, 10000);
  };
  const received = (socket: Socket<RelayPending>, chunk: Uint8Array) => {
    if (socket.data.peer) socket.data.peer.write(chunk);
    else {
      socket.data.buffer = append(socket.data.buffer, chunk);
      if (socket.data.buffer.length > 65536) socket.end();
    }
  };
  const closed = (socket: Socket<RelayPending>, queue: Socket<RelayPending>[]) => {
    if (socket.data.closed) return;
    socket.data.closed = true;
    const index = queue.indexOf(socket);
    if (index >= 0) queue.splice(index, 1);
    const peer = socket.data.peer;
    socket.data.peer = undefined;
    if (peer && !peer.data.closed) { peer.data.peer = undefined; peer.end(); }
  };
  const browser = listen<RelayPending>({ unix: socketPath, socket: {
    open: socket => opened(socket, waitingBrowser, waitingLocal, true),
    data: received,
    close: socket => closed(socket, waitingBrowser),
    error: socket => { closed(socket, waitingBrowser); socket.end(); },
  } });
  try {
    const local = listen<RelayPending>({ hostname: "127.0.0.1", port: 0, socket: {
      open: socket => opened(socket, waitingLocal, waitingBrowser, false),
      data: received,
      close: socket => closed(socket, waitingLocal),
      error: socket => { closed(socket, waitingLocal); socket.end(); },
    } });
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
  let proxy: UnixSocketListener<Pending> | undefined;
  let relay: ReturnType<typeof startCdpRelay> | undefined;
  try {
    proxy = startProxy(proxySocket, request.origins, authority => { if (!refused.includes(authority)) refused.push(authority); });
    relay = startCdpRelay(cdpSocket);
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
