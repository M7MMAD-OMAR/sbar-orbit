import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { listen } from "bun";
import { launchChrome } from "../src/chrome";
import { openEgressLease } from "../src/egress";
import { detectPlatform } from "../src/platform";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * Gate: does a session actually WORK with no network of its own, over the transport a real session uses?
 *
 * `experiments/egress-lease.ts` measured the mechanism and left two things unmeasured, both of which
 * decide whether it can be wired into the session lifecycle at all:
 *
 *   CDP over TCP. That experiment used `launchPersistentContext`, which speaks CDP over an inherited
 *   pipe, so the namespace was invisible to it. Orbit's own launcher publishes a debugging port and
 *   dials `ws://127.0.0.1:port`, and inside a network namespace that port is not a port on this
 *   machine. If the relay does not carry the handshake, the wiring is impossible rather than awkward.
 *
 *   CONNECT. That experiment's fixtures were plain HTTP. Every origin worth leasing is https, and
 *   https through a proxy is a CONNECT tunnel, which the Bun.serve based proxy there could not answer
 *   at all. A lease measured only on http is a lease measured on nothing a person uses.
 *
 * The https assertion is made at the far end of the tunnel, not in the page: a local TLS handshake
 * against a socket that speaks no TLS fails in the browser either way, and what is being measured is
 * whether the leased authority was reached and the unleased one was not.
 */
await requireResourceBudget();
const capabilities = await detectPlatform();
const report: Record<string, unknown> = {
  date: new Date().toISOString().slice(0, 10),
  confinedEgressAvailable: capabilities.confinedEgress,
};
const browser = capabilities.browsers.find(install => install.executable);
if (!capabilities.confinedEgress || !browser?.executable) {
  console.log(JSON.stringify({ ...report, skipped: "This host cannot confine a browser, or has no browser." }, null, 2));
  process.exit(0);
}

const root = await mkdtemp(join(homedir(), ".cache", "orbit-confined-"));
let pageHits = 0;
const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { pageHits++; return new Response("<h1>leased</h1>", { headers: { "Content-Type": "text/html" } }); } });
/** Two sockets that answer nothing, to count TLS tunnels rather than serve them. */
const counted = (name: string) => {
  let connections = 0;
  const server = listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { open: socket => { connections++; socket.end(); }, data: () => {}, close: () => {} } });
  return { name, port: server.port, stop: () => server.stop(true), count: () => connections };
};
const leasedTls = counted("leased-tls");
const unleasedTls = counted("unleased-tls");
let unleasedHits = 0;
const unleasedPage = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { unleasedHits++; return new Response("unleased"); } });

const origins = [`http://127.0.0.1:${page.port}`, `https://127.0.0.1:${leasedTls.port}`];
report.lease = origins;

try {
  const lease = await openEgressLease({
    directory: join(root, "egress"), executable: browser.executable, confinable: true, origins: () => origins,
    profile: join(root, "profile"),
  });
  report.tier = lease.tier;
  const profile = join(root, "profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  let owned: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    owned = await launchChrome(profile, { width: 800, height: 600 }, {
      executable: lease.launch.executable, extraArgs: lease.launch.args, endpointPort: lease.endpointPort,
    });
    // 1. CDP crossed the boundary at all. Everything else in this file depends on it.
    report.cdpAcrossTheNamespace = true;
    // 2. A leased plain HTTP origin still loads, because a session that cannot browse is not confined,
    //    it is broken.
    const navigation = await owned.page.goto(origins[0]!, { waitUntil: "domcontentloaded", timeout: 20000 }).then(() => true).catch(() => false);
    report.leasedPageLoaded = navigation && pageHits > 0;
    report.leasedPageTitle = await owned.page.evaluate(() => document.body?.innerText.trim().slice(0, 40)).catch(() => null);

    // 3. https, which is the only thing a real session uses. Measured at the far end of the tunnel.
    const attempts: Record<string, unknown> = {};
    for (const target of [`https://127.0.0.1:${leasedTls.port}/probe`, `https://127.0.0.1:${unleasedTls.port}/probe`, `http://127.0.0.1:${unleasedPage.port}/probe`]) {
      attempts[target] = await owned.page.evaluate(async url => {
        try { const response = await fetch(url, { mode: "no-cors" }); return `reached ${response.status || "opaque"}`; }
        catch (error) { return `blocked: ${String(error).slice(0, 50)}`; }
      }, target).catch(error => `blocked: ${String(error).split("\n")[0]?.slice(0, 50)}`);
    }
    report.whatThePageThinksHappened = attempts;
    report.leasedTlsAuthorityTunnelled = leasedTls.count() > 0;
    report.unleasedTlsAuthorityTunnelled = unleasedTls.count() > 0;
    // What the page thinks happened is not evidence: a no-cors fetch sees an opaque response for the
    // lease's 403 exactly as it would for a 200. Whether the origin server was touched is not ambiguous.
    report.unleasedHttpOriginServed = unleasedHits > 0;
    report.authoritiesTheLeaseRefused = lease.refused();
  } finally {
    await owned?.close();
    await lease.close();
    // 4. Nothing of the lease outlives the session: no sockets, no directory, no relay.
    report.leaseDirectoryLeft = await Bun.file(join(root, "egress", "lease.sock")).exists();
    const socats = Bun.spawn(["/usr/bin/pgrep", "-fa", "orbit-confined"], { stdout: "pipe", stderr: "ignore" });
    report.helpersLeftRunning = (await new Response(socats.stdout).text()).trim().split("\n").filter(Boolean).length;
  }
} catch (error) {
  report.failure = String(error).split("\n").at(0)?.slice(0, 300);
} finally {
  page.stop(true); unleasedPage.stop(true); leasedTls.stop(); unleasedTls.stop();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

await mkdir("output", { recursive: true, mode: 0o700 });
await writeFile(join("output", `confined-egress-${report.date}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
