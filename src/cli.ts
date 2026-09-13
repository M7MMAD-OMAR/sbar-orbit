import { startBroker, call } from "./ipc";
import { serviceSocketPath } from "./service";
import { OrbitError } from "./errors";

// The fourth word means whatever the verb needs: an account name to create with, a restore point to
// return to. Named for its position rather than for one of its meanings.
const [command, verb, arg, fourth] = process.argv.slice(2);
try {
  if (command === "status") {
    // Read-only, and reachable without ORBIT_SOCKET when the managed broker is running.
    const { readStatus, summarize, socketFromEnvironment } = await import("./status");
    const status = await readStatus(socketFromEnvironment());
    console.log(JSON.stringify({ ...status, summary: summarize(status) }, null, process.argv.includes("--json") ? 0 : 2));
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
    const socket = process.env.ORBIT_SOCKET;
    if (!socket) throw new OrbitError("CONFIG_REQUIRED", "Set ORBIT_SOCKET to the socket printed by serve");
    let method: string;
    let params: unknown = {};
    if (command === "doctor") method = "doctor";
    else if (command === "preview" && verb === "browsers") method = "viewer.browsers";
    // `preview` prints the link and opens nothing, which is what a script wants. `preview open` is the
    // person's command: it opens their chosen browser, in a window of its own where that browser has one.
    else if (command === "preview") { method = "preview.open"; params = { launch: verb === "open", browser: arg }; }
    else if (command === "account" && verb === "save") { method = "session.account.save"; params = { sessionId: arg }; }
    else if (command === "session" && ["create", "stop", "pause", "resume", "observe", "list", "journal", "restore"].includes(verb ?? "")) {
      method = `session.${verb}`;
      // The journal is how an autonomous run is reviewed after it finishes, and a restore is how one is
      // put back, so both belong on the command line a person uses rather than in the agent API alone.
      params = verb === "create" ? { backend: arg ?? "browser", accountName: fourth, agentName: process.env.ORBIT_AGENT_NAME, taskName: process.env.ORBIT_TASK_NAME }
        : verb === "restore" && fourth !== undefined ? { sessionId: arg, sequence: Number(fourth) }
        : { sessionId: arg };
    } else if (command === "act") {
      method = "session.act";
      params = { sessionId: verb, requestId: process.env.ORBIT_REQUEST_ID ?? crypto.randomUUID(), action: JSON.parse(arg ?? "null") };
    } else throw new OrbitError("INVALID_REQUEST", "Use serve, status, clean, doctor, preview, preview open, preview browsers, session create/list/stop/pause/resume/observe/journal/restore, or act ID JSON");
    console.log(JSON.stringify({ ok: true, result: await call(socket, method, params) }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: error instanceof OrbitError ? error.code : "CLI_ERROR",
    message: error instanceof OrbitError ? error.message : "Command failed" } }));
  process.exitCode = 1;
}
