import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { Sessions } from "../src/session";
import { requireResourceBudget } from "../src/resource-budget";

/**
 * What does the origin lease actually stop?
 *
 * The policy check in the broker decides what the AGENT may ask for. It stops the agent and nothing
 * else: a page redirects itself, loads an iframe, fetches, or opens a popup, and none of that is an
 * action the agent requested. This measures each of those routes off the allowed origin, so the
 * answer is a table rather than a claim.
 *
 * No real profile and no real account: two disposable local servers stand in for the allowed origin
 * and for everywhere else.
 */
await requireResourceBudget();
const root = await createWorkspaceDirectory("origin-lease");
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };

/** Everywhere else. Every hit here is the lease failing to hold. */
let reached: string[] = [];
const offLimits = Bun.serve({ hostname: "127.0.0.1", port: 0,
  // A socket that upgrades is a route out that no request interception sees as a document.
  websocket: { message() {}, open(ws) { reached.push("/via-websocket"); ws.close(); } },
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/via-websocket") { if (server.upgrade(request)) return undefined; }
    reached.push(path);
    return new Response("<h1>off lease</h1>", { headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" } });
  } });
const away = `http://127.0.0.1:${offLimits.port}`;

const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  // A page that redirects itself the moment it is opened.
  if (url.pathname === "/redirect") return Response.redirect(`${away}/via-redirect`, 302);
  // A service worker outlives the page and fetches on its own schedule, which is why it is worth
  // asking separately whether the lease reaches it.
  if (url.pathname === "/sw.js") return new Response(
    `self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(Promise.all([
       fetch("${away}/via-serviceworker").catch(()=>{}),
       fetch("/worker-ran").catch(()=>{})
     ])); });`,
    { headers: { "Content-Type": "text/javascript" } });
  // Hit by the worker itself. If this never arrives, a blocked off-lease fetch proves nothing,
  // because the worker never ran to make one.
  if (url.pathname === "/worker-ran") { workerRan = true; return new Response("ok"); }
  const body = {
    "/": `<h1>allowed</h1>`,
    "/iframe": `<h1>allowed</h1><iframe src="${away}/via-iframe"></iframe>`,
    "/image": `<h1>allowed</h1><img src="${away}/via-image">`,
    "/fetch": `<h1>allowed</h1><script>fetch('${away}/via-fetch').catch(()=>{})</script>`,
    "/script": `<h1>allowed</h1><script src="${away}/via-script"></script>`,
    "/meta": `<h1>allowed</h1><meta http-equiv="refresh" content="0;url=${away}/via-meta">`,
    "/jsnav": `<h1>allowed</h1><script>location.href='${away}/via-jsnav'</script>`,
    "/popup": `<h1>allowed</h1><script>window.open('${away}/via-popup')</script>`,
    "/beacon": `<h1>allowed</h1><script>navigator.sendBeacon('${away}/via-beacon','x')</script>`,
    "/serviceworker": `<h1>allowed</h1><output id=o>registering</output><script>
      navigator.serviceWorker.register('/sw.js').then(()=>{o.textContent='registered'},e=>{o.textContent='register failed: '+e})</script>`,
    // The socket records its own fate, so a blocked one is distinguishable from one never opened.
    "/websocket": `<h1>allowed</h1><output id=o>opening</output><script>
      try { const w = new WebSocket('ws://127.0.0.1:${offLimits.port}/via-websocket');
        w.onopen = () => o.textContent = 'OPENED';
        w.onerror = () => o.textContent = 'refused';
        w.onclose = () => { if (o.textContent === 'opening') o.textContent = 'refused'; };
      } catch (e) { o.textContent = 'threw: ' + e }</script>`,
  }[url.pathname];
  return new Response(body ?? "<h1>allowed</h1>", { headers: { "Content-Type": "text/html" } });
} });
const allowed = `http://127.0.0.1:${site.port}`;
let workerRan = false;

const sessions = new Sessions(root);
try {
  const run = (method: string, params: unknown = {}) => sessions.dispatch({ method, params });
  const act = (session: object, action: unknown) => run("session.act", { ...session, requestId: crypto.randomUUID(), action });
  const created = await run("session.create", {
    backend: "browser", taskName: "Origin lease probe",
    policy: { mode: "autonomous", origins: [allowed], allow: ["read", "navigate", "write"] },
  }) as { sessionId: string };
  const session = { sessionId: created.sessionId };

  const routes: Record<string, string> = {};
  for (const [name, path] of Object.entries({
    "top-level redirect": "/redirect", "iframe": "/iframe", "image": "/image", "fetch": "/fetch",
    "script tag": "/script", "meta refresh": "/meta", "javascript navigation": "/jsnav",
    "window.open popup": "/popup", "sendBeacon": "/beacon",
    "service worker fetch": "/serviceworker", "websocket": "/websocket",
  })) {
    reached = [];
    try { await act(session, { type: "navigate", url: `${allowed}${path}` }); } catch { /* a blocked top level navigation is a failure to navigate */ }
    // Give the page a moment to make its own requests before judging.
    await Bun.sleep(1600);
    routes[name] = reached.length ? `REACHED ${reached.join(",")}` : "blocked";
    // The page's own account of what happened, so a "blocked" row is backed by a mechanism that ran.
    if (path === "/serviceworker" || path === "/websocket")
      routes[`${name} (the page's own report)`] = await act(session, { type: "read", selector: "#o" })
        .then(result => (result as { text: string }).text, () => "unreadable");
  }
  report.pageInitiated = routes;
  // The control: did the worker run at all? Without this a blocked off-lease fetch proves nothing.
  report.serviceWorkerActuallyRan = workerRan;

  // The agent asking directly, which is the case the broker already decided.
  reached = [];
  report.agentNavigation = await act(session, { type: "navigate", url: `${away}/direct` })
    .then(() => "allowed", error => (error as { code?: string }).code);
  report.agentNavigationReachedServer = reached.length > 0;

  const journal = await run("session.journal", session) as { blockedOrigins: string[] };
  report.blockedOriginsRecorded = journal.blockedOrigins;
  await run("session.stop", session);
} finally {
  await sessions.close();
  site.stop(true); offLimits.stop(true);
  await rm(root, { recursive: true, force: true });
}

await mkdir("output", { recursive: true, mode: 0o700 });
const path = join("output", `origin-lease-${report.date}.json`);
await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
