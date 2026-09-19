import { startBroker, call } from "./ipc";
import { serviceSocketPath } from "./service";
import { OrbitError } from "./errors";
import { ConversationUsage } from "./conversation-usage";
import { observationOptions, saveObservation } from "./observation-output";

/**
 * The action document for `act`, from an argument, a file, or standard input.
 *
 * `act ID '{"type":"navigate",...}'` is the documented form and still works. It is also the form
 * that cannot be typed reliably on Windows: PowerShell strips the inner quotes before the process
 * sees them, so the CI job that drives this had to route the whole command back through `cmd /c`
 * with doubled quotes, and the first runner it ran on still produced
 * `CLI_ERROR: JSON Parse error: Unterminated string`. Quoting is the host shell's business and not
 * something a caller should have to defeat, so two shell independent forms are accepted:
 *
 *   act ID @path/to/action.json     read the document from a file
 *   act ID -                        read the document from standard input
 *
 * A malformed document now says what it could not parse and where it came from, rather than
 * surfacing Bun's parser message with no context.
 */
async function actionDocument(argument: string | undefined): Promise<unknown> {
  let source = "the command line";
  let raw = argument ?? "null";
  if (argument === "-") { source = "standard input"; raw = await new Response(Bun.stdin.stream()).text(); }
  else if (argument?.startsWith("@")) {
    const path = argument.slice(1);
    source = path;
    // A REGULAR FILE, checked before anything is read. `Bun.file(path).text()` on a character device
    // reads without bound: measured on Fedora 44, `act s @/dev/zero` reached 8.4 GiB resident in 8
    // seconds with nothing on stdout and no error, and a FIFO nobody writes to hangs on the same
    // line with no memory growth at all, which is the quiet form of it. The documented remedy for a
    // shell that eats quotes IS `@path`, so a mistyped path that lands on a device turns a one line
    // command into an out of memory event, and on a machine where several agents share one budget
    // that is everyone's problem rather than this process's.
    const file = Bun.file(path);
    const { statSync } = await import("node:fs");
    let regular: boolean;
    try { regular = statSync(path).isFile(); }
    catch { throw new OrbitError("INVALID_REQUEST", `No action document at ${path}`); }
    if (!regular) throw new OrbitError("INVALID_REQUEST",
      `The action document at ${path} is not a regular file. A device, a FIFO or a directory cannot be read as one.`);
    // And a ceiling even on a regular file, since a regular file can also be enormous. An action
    // document is a small object; a megabyte is already far past anything legitimate.
    if (file.size > 1_048_576) throw new OrbitError("INVALID_REQUEST",
      `The action document at ${path} is ${file.size} bytes. An action document is a small JSON object, and anything past 1 MiB is a mistyped path.`);
    try { raw = await file.text(); }
    catch { throw new OrbitError("INVALID_REQUEST", `No action document at ${path}`); }
  }
  try { return JSON.parse(raw); }
  catch (error) {
    // The parser's message is NOT repeated, and that is the whole point of this branch. Bun quotes
    // the offending token in it, so a file that can be read but not parsed had its first token
    // echoed to stdout: `act s @secrets.env` answered with the name and value sitting at the top of
    // that file. Not a privilege boundary, since the CLI runs as the person and could read the file
    // anyway, but a disclosure into a channel that LEAVES the process: an agent host captures this
    // stdout, and a person pasting a failed command into an issue pastes the first token of whatever
    // they pointed at. src/policy.ts and src/diagnostics.ts both work to keep file content out of
    // every record; this path put it into one.
    //
    // The parse failure is reported WITHOUT the parser's message and without any content from the
    // document. Bun's message carries no position, only the quoted token, so there is no position to
    // report either.
    //
    // Recovering one by bisection was tried and removed: it assumed Bun distinguishes an INCOMPLETE
    // document from a WRONG one, and it does not. `{`, `{"a"` and `{"type": "observe",` all fail
    // with ordinary syntax messages rather than an end-of-input one, so every prefix reads as wrong,
    // the search collapses to zero, and the answer is a confident "at position 0" on every document
    // alike. A number that is always the same number is worse than no number: it reads as a
    // measurement and is not one.
    //
    // The document's LENGTH is reported, which is the one fact available here that is both true and
    // useful: it separates "the shell truncated my JSON" from "my JSON is wrong" without quoting a
    // single byte of it.
    throw new OrbitError("INVALID_REQUEST",
      `The action document from ${source} is not JSON (${raw.length} bytes read). Where a shell eats quotes, pass it as a file with @path or on standard input with a bare -.`);
  }
}

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
    // On macOS, reap browser trees whose supervisor was killed before it could sweep its own group.
    // This is the second containment layer, and it runs BEFORE the workspace sweep below rather than
    // after: `cleanWorkspaces` decides a workspace is abandoned because no broker answers for it and
    // deletes the directory, so cleaning first would delete the profile of a browser that is still
    // running out of it. Ownership is proved from the recorded leader start time and executable
    // before anything is signalled, so a reused process group id is reported and left alone.
    const orphans = managed && process.platform === "darwin"
      ? await (await import("./macos-orphans")).sweepOrphanedSessions().catch(() => undefined)
      : undefined;
    // Measured 13 September 2026: 417 workspaces and 7.2 GB left behind by brokers that were
    // stopped or killed, because the only thing that reclaimed them was a command nobody ran. A
    // managed broker is the one that outlives them all, so it sweeps when it starts. Only directories
    // whose owner does not answer go; a private broker started by a test keeps its own.
    const swept = managed ? await (await import("./workspace-storage")).cleanWorkspaces().catch(() => undefined) : undefined;
    console.log(JSON.stringify({ socket: broker.socket, managed,
      ...(swept ? { swept: swept.removed.length } : {}),
      // Reported rather than silent: a reaped orphan means a supervisor died badly, and a refusal
      // means a group could not be proved Orbit's, which somebody should be able to see.
      ...(orphans && (orphans.swept.length || orphans.refused.length)
        ? { orphansReaped: orphans.swept.length, orphansRefused: orphans.refused.length } : {}) }));
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
      params = { sessionId: verb, requestId: process.env.ORBIT_REQUEST_ID ?? crypto.randomUUID(), action: await actionDocument(arg) };
    } else throw new OrbitError("INVALID_REQUEST", "Use serve, status, clean, doctor, preview, preview open, preview browsers, session create/list/stop/pause/resume/observe/journal/restore, or act ID JSON|@FILE|-");
    const result = await call(socket, method, params);
    console.log(JSON.stringify({ ok: true, result: observation?.mode === "file" ? await saveObservation(result, observation.path) : result }));
  }
} catch (error) {
  // An OrbitError carries a message meant for a person. Anything else used to be reported as the bare
  // string "Command failed", which on Windows meant a broker that would not start said nothing at all
  // about why. The real message is kept, trimmed, because a diagnosable failure is worth more than a
  // uniform one. ORBIT_DEBUG=1 adds the stack for the case where the message alone is not enough.
  const message = error instanceof OrbitError ? error.message
    : `Command failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 300)}`;
  console.error(JSON.stringify({ ok: false, error: { code: error instanceof OrbitError ? error.code : "CLI_ERROR",
    diagnosticId: error instanceof OrbitError ? error.diagnosticId : undefined,
    message,
    ...(process.env.ORBIT_DEBUG && error instanceof Error && error.stack ? { stack: error.stack.split("\n").slice(0, 8) } : {}) } }));
  process.exitCode = 1;
}
