import { chromium, type BrowserContext } from "playwright";
import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Gate: is a denied origin unreachable from PAGE SCRIPT, and not only from `session.act`?
 *
 * Request interception already holds eleven page initiated routes, measured. It holds them inside
 * the browser, which is the right place for a page that is merely following instructions and the
 * wrong place for a browser that is not doing what it is told. Orbit launches Chrome with
 * `--no-sandbox`, so a renderer that is not behaving is not a hypothetical distinction.
 *
 * This measures the layer below: Chrome in an empty network namespace, whose only way out is a proxy
 * that holds the lease. Nothing in the browser is trusted to enforce anything.
 *
 * Three configurations, because one result alone proves nothing:
 *   direct      no namespace, no proxy: the control. Both origins must be reachable, or the fixture
 *               is broken rather than the lease working.
 *   proxy       the proxy alone, browser unconfined. Holds a browser that asks politely.
 *   confined    empty network namespace plus the proxy. The only route out is the proxy.
 */
await requireResourceBudget();
const CHROME = "/opt/google/chrome/chrome";
const base = await mkdtemp(join(tmpdir(), "orbit-egress-"));
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };

let allowedHits = 0, deniedHits = 0;
const allowedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { allowedHits++; return new Response("<h1>allowed</h1>", { headers: { "Content-Type": "text/html" } }); } });
const deniedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { deniedHits++; return new Response("<h1>denied</h1>", { headers: { "Content-Type": "text/html" } }); } });
const allowed = `http://127.0.0.1:${allowedServer.port}`;
const denied = `http://127.0.0.1:${deniedServer.port}`;

/**
 * The lease, held outside the browser. A forward proxy that answers CONNECT and plain GET for the
 * origins it was given at creation and refuses everything else, recording what it refused.
 */
const refused: string[] = [];
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const target = new URL(request.url);
  const origin = `${target.protocol}//${target.host}`;
  if (origin !== allowed) { refused.push(origin); return new Response("blocked by the lease", { status: 403 }); }
  return fetch(target.toString(), { headers: request.headers, method: request.method });
} });
const proxyAddress = `127.0.0.1:${proxy.port}`;

/** Chrome under bubblewrap with no network of its own, reaching the proxy through a unix socket. */
async function confinedLauncher(socketPath: string) {
  const wrapper = join(base, "confined-chrome.sh");
  await writeFile(wrapper, `#!/bin/sh
# An empty network namespace: no route, no DNS, nothing but its own loopback. The only way out is
# the relay below, which carries the proxy in over a unix socket, because a unix socket is
# filesystem rather than network and crosses the namespace.
exec /usr/bin/bwrap --unshare-net --dev-bind / / --die-with-parent /bin/sh -c '
  /usr/bin/socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${socketPath} &
  exec ${CHROME} "$@"
' chrome "$@"
`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function reachFrom(context: BrowserContext, url: string) {
  const page = context.pages()[0] ?? await context.newPage();
  // Page script, not an agent action: this is the layer that request interception governs and that a
  // misbehaving renderer would bypass.
  return page.evaluate(async target => {
    try { const response = await fetch(target, { mode: "no-cors" }); return `reached ${response.status || "opaque"}`; }
    catch (error) { return `blocked: ${String(error).slice(0, 60)}`; }
  }, url).catch(error => `blocked: ${String(error).split("\n")[0]?.slice(0, 60)}`);
}

async function run(name: string, options: { executablePath: string; args: string[] }) {
  allowedHits = 0; deniedHits = 0; refused.length = 0;
  const profile = join(base, `profile-${name}`);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: options.executablePath,
      args: ["--no-first-run", "--no-default-browser-check", "--no-sandbox", "--password-store=basic", ...options.args],
      timeout: 30000,
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(allowed, { waitUntil: "domcontentloaded", timeout: 15000 });
    await reachFrom(context, `${allowed}/probe`);
    await reachFrom(context, `${denied}/probe`);
    // What the page THINKS it got is not evidence: a no-cors fetch returns an opaque response for a
    // 403 just as it does for a 200. Whether the origin server was touched is not ambiguous.
    return {
      browserStarted: true,
      allowedOriginServerHit: allowedHits > 0,
      deniedOriginServerHit: deniedHits > 0,
      originsTheLeaseRefused: [...new Set(refused)].length,
    };
  } catch (error) { return { browserStarted: false, reachedNothingAtAll: true, error: String(error).split("\n").at(0)?.slice(0, 160) }; }
  finally { if (context) await context.close().catch(() => {}); }
}

const bridge = Bun.spawn(["/usr/bin/socat", `UNIX-LISTEN:${join(base, "proxy.sock")},fork,mode=600`, `TCP:${proxyAddress}`],
  { stdout: "ignore", stderr: "ignore" });
try {
  for (let attempt = 0; attempt < 60 && !(await Bun.file(join(base, "proxy.sock")).exists()); attempt++) await Bun.sleep(50);

  // The control. If both origins are not reachable here, the fixture is broken and nothing below means anything.
  report.direct = await run("direct", { executablePath: CHROME, args: [] });
  // Chrome bypasses its proxy for loopback by default, and both fixtures here are on 127.0.0.1, so
  // without this the browser talks to the origin directly and the proxy sees nothing. Found by this
  // experiment failing: it is a real caveat for any lease that leans on a proxy, because the bypass
  // list is a browser setting and therefore something the browser decides to honour.
  const throughProxy = "--proxy-bypass-list=<-loopback>";
  // The proxy alone. Holds a browser that asks politely for its network.
  report.proxyOnly = await run("proxy", { executablePath: CHROME, args: [`--proxy-server=${proxyAddress}`, throughProxy] });
  // The proxy, with a browser that has no other way out at all.
  report.confined = await run("confined", {
    executablePath: await confinedLauncher(join(base, "proxy.sock")),
    args: ["--proxy-server=127.0.0.1:8888", throughProxy],
  });
  // And the point of the namespace: the same browser, confined, with the proxy setting removed. If
  // the namespace is doing its job this reaches nothing at all, proxy or no proxy.
  report.confinedWithProxySettingRemoved = await run("confined-noproxy", {
    executablePath: await confinedLauncher(join(base, "proxy.sock")),
    args: [],
  });
} catch (error) {
  report.failure = String(error).split("\n").at(0)?.slice(0, 300);
} finally {
  bridge.kill();
  allowedServer.stop(true); deniedServer.stop(true); proxy.stop(true);
  await rm(base, { recursive: true, force: true });
}

await mkdir("output", { recursive: true, mode: 0o700 });
await writeFile(join("output", `egress-lease-${report.date}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
