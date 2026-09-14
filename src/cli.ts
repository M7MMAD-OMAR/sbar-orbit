import { startBroker, call } from "./ipc";
import { serviceSocketPath } from "./service";
import { OrbitError } from "./errors";
import { ConversationUsage } from "./conversation-usage";
import { observationOptions, saveObservation } from "./observation-output";

// The fourth word means whatever the verb needs: an account name to create with, a restore point to
// return to. Named for its position rather than for one of its meanings.
const [command, verb, arg, fourth] = process.argv.slice(2);
try {
  const usage = new ConversationUsage(command === "usage" ? arg ?? process.env.ORBIT_CONVERSATION_ID : undefined);
  if (command !== "usage" && command !== "serve") await usage.assertEnabled();
  if (command === "usage") {
    if (!usage.conversationId) throw new OrbitError("CONVERSATION_REQUIRED", "Set ORBIT_CONVERSATION_ID for this conversation, or use usage on|off|status ID");
    if (!["on", "off", "status"].includes(verb ?? "") || fourth !== undefined) throw new OrbitError("INVALID_REQUEST", "Use usage on|off|status [ID]");
    console.log(JSON.stringify({ ok: true, result: verb === "status" ? await usage.status() : await usage.set(verb as "on" | "off") }));
  } else if (command === "diagnostics") {
    const { Diagnostics, diagnosticRoot } = await import("./diagnostics");
    const socket = process.env.ORBIT_SOCKET ?? serviceSocketPath();
    let report: unknown;
    try { report = await call(socket, "diagnostics.report"); }
    catch { report = await new Diagnostics(diagnosticRoot()).report(); }
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "status") {
    // Read-only, and reachable without ORBIT_SOCKET when the managed broker is running.
    const { readStatus, summarize, socketFromEnvironment } = await import("./status");
    const status = await readStatus(socketFromEnvironment());
    console.log(JSON.stringify({ ...status, summary: summarize(status) }, null, process.argv.includes("--json") ? 0 : 2));
  } else if (command === "update") {
    // Local: which version is current, which are prepared, and pointing the link at one of them. It
    // never fetches anything, and it refuses while a session is open rather than ending it.
    const { activateVersion, updateStatus, pruneVersions, checkForUpdate, prepareVersion, runUpdate, setAutomaticUpdates, automaticUpdates } = await import("./update");
    const running = (await import("../package.json")).version;
    if (verb === undefined || verb === "status") console.log(JSON.stringify({ ...await updateStatus(), automatic: await automaticUpdates() }, null, 2));
    else if (verb === "on" || verb === "off") console.log(JSON.stringify(await setAutomaticUpdates(verb === "on"), null, 2));
    else if (verb === "run") console.log(JSON.stringify(await runUpdate(running), null, 2));
    else if (verb === "check") console.log(JSON.stringify(await checkForUpdate(running), null, 2));
    else if (verb === "stage") {
      // Reaches the feed and the network, and stops there. Preparing is the half that is safe to do
      // while a session is open, because nothing points at what it prepares.
      const found = await checkForUpdate(running);
      if (!found.eligible) { console.log(JSON.stringify(found, null, 2)); process.exitCode = 1; }
      else console.log(JSON.stringify({ ...found, ...await prepareVersion(found.eligible) }, null, 2));
    }
    else if (verb === "activate") {
      if (!arg) throw new OrbitError("INVALID_REQUEST", "Use update activate VERSION");
      const outcome = await activateVersion(arg);
      console.log(JSON.stringify(outcome, null, 2));
      if (!outcome.activated) process.exitCode = 1;
    }
    else if (verb === "prune") console.log(JSON.stringify(await pruneVersions(), null, 2));
    else throw new OrbitError("INVALID_REQUEST", "Use update status|on|off|check|stage|run|activate VERSION|prune");
  } else if (command === "clean") {
    // Profiles that outlived their broker. No socket is needed; a live broker's directory is kept.
    const { cleanWorkspaces } = await import("./workspace-storage");
    console.log(JSON.stringify(await cleanWorkspaces(), null, 2));
  } else if (command === "doctor" && process.argv.includes("--report")) {
    // Deliberately local, and before the branch that requires a socket. The most common thing a person
    // reports is a broker that will not start, which is exactly the case a broker RPC cannot answer.
    // Nothing here needs Orbit to be running, and nothing here leaves the machine on its own.
    const { describeMachine, hostClassTier } = await import("./platform");
    const { version } = await import("../package.json");
    console.log(JSON.stringify({
      ...await describeMachine(),
      orbitVersion: version,
      // What this host class may claim, which is never what it managed to run.
      tier: { ...await hostClassTier(), reference: "docs/support-tiers.md" },
      paste: "This report is safe to paste into a public issue. Read it first anyway.",
    }, null, 2));
  } else if (command === "serve") {
    // A managed broker binds the fixed path a service unit and generated host configuration expect.
    const managed = process.argv.includes("--managed-socket");
    const broker = await startBroker(managed ? { socketPath: serviceSocketPath() } : {});
    // Measured 13 September 2026: 417 workspaces and 7.2 GB left behind by brokers that were
    // stopped or killed, because the only thing that reclaimed them was a command nobody ran. A
    // managed broker is the one that outlives them all, so it sweeps when it starts. Only directories
    // whose owner does not answer go; a private broker started by a test keeps its own.
    const swept = managed ? await (await import("./workspace-storage")).cleanWorkspaces().catch(() => undefined) : undefined;
    console.log(JSON.stringify({ socket: broker.socket, managed, ...(swept ? { swept: swept.removed.length } : {}) }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await broker.close();
      process.exit(0);
    };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  } else {
    const socket = process.env.ORBIT_SOCKET ?? serviceSocketPath();
    const observation = command === "session" && verb === "observe" ? observationOptions(process.argv.slice(5)) : undefined;
    let method: string;
    let params: unknown = {};
    if (command === "doctor") method = "doctor";
    else if (command === "preview" && verb === "browsers") method = "viewer.browsers";
    // `preview` prints the link and opens nothing, which is what a script wants. `preview open` is the
    // person's command: it opens their chosen browser, in a window of its own where that browser has one.
    else if (command === "preview") { method = "preview.open"; params = { launch: verb === "open", browser: arg }; }
    else if (command === "account" && verb === "save") { method = "session.account.save"; params = { sessionId: arg }; }
    else if (command === "session" && ["create", "stop", "pause", "resume", "observe", "list", "journal", "restore"].includes(verb ?? "")) {
      method = observation?.mode === "metadata" ? "session.presence" : `session.${verb}`;
      // The journal is how an autonomous run is reviewed after it finishes, and a restore is how one is
      // put back, so both belong on the command line a person uses rather than in the agent API alone.
      params = verb === "create" ? { backend: arg ?? "browser", accountName: fourth, agentName: process.env.ORBIT_AGENT_NAME, taskName: process.env.ORBIT_TASK_NAME, conversationName: process.env.ORBIT_CONVERSATION_NAME, projectName: process.env.ORBIT_PROJECT_NAME }
        : verb === "restore" && fourth !== undefined ? { sessionId: arg, sequence: Number(fourth) }
        : { sessionId: arg };
    } else if (command === "act") {
      method = "session.act";
      params = { sessionId: verb, requestId: process.env.ORBIT_REQUEST_ID ?? crypto.randomUUID(), action: JSON.parse(arg ?? "null") };
    } else throw new OrbitError("INVALID_REQUEST", "Use serve, status, clean, doctor, preview, preview open, preview browsers, session create/list/stop/pause/resume/observe/journal/restore, or act ID JSON");
    const result = await call(socket, method, params);
    console.log(JSON.stringify({ ok: true, result: observation?.mode === "file" ? await saveObservation(result, observation.path) : result }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: error instanceof OrbitError ? error.code : "CLI_ERROR",
    diagnosticId: error instanceof OrbitError ? error.diagnosticId : undefined,
    message: error instanceof OrbitError ? error.message : "Command failed" } }));
  process.exitCode = 1;
}
