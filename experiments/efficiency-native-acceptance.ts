/** Manual source experiment, not a production interface or an automated acceptance test.
 * Run only after reviewing current native readiness and the visible workspace with the owner.
 * NDJSON stdin: {"tool":"orbit_monitors","arguments":{}}. No native operations without --run.
 * No performance target, visibility, application acceptance or closure is inferred from an ack.
 * After uncertain input, the operator must inspect via observe/state before further mutation; never blindly replay.
 */
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const APPLICATION = "org.gnome.Calculator.desktop";
const workspaceSetting = process.env.ORBIT_ACCEPTANCE_WORKSPACE ?? "1";
const WORKSPACE = Number(workspaceSetting); // Explicit manual selection, never auto-presentation.
const MAX_LINE_BYTES = 65536;
const allowed = new Set(["orbit_applications", "orbit_monitors", "orbit_handoff_candidates", "orbit_open", "orbit_handoff",
  "internal_owner_snapshot", "internal_passive_observe", "orbit_status", "orbit_observe", "orbit_act", "orbit_pause", "orbit_resume", "orbit_journal", "orbit_narrow", "orbit_stop"]);
type Fields = Record<string, unknown>;
class Refusal extends Error {}
function refuse(message: string): never { throw new Refusal(message); }
function object(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("Expected a JSON object");
  return value as Fields;
}
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  const result: Fields = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(image|data|password|secret|authorization|cookie|ownerToken|credential)$/i.test(key)) continue;
    result[key] = clean(item);
  }
  return result;
}
function compact(tool: string, data: Fields): unknown {
  if (tool === "orbit_observe" || tool === "orbit_act" && data.capture) {
    const frame = tool === "orbit_observe" ? data : object(data.capture);
    const tree = frame.tree && typeof frame.tree === "object" ? object(frame.tree) : {};
    return { ...(tool === "orbit_act" ? { ok: data.ok, completed: data.completed, receipts: data.receipts, captureError: data.captureError } : {}),
      appId: frame.appId, windowId: frame.windowId, mimeType: frame.mimeType, width: frame.width, height: frame.height,
      capturedAt: frame.capturedAt, presence: frame.presence,
      treeSummary: { status: tree.status, nodeCount: Array.isArray(tree.nodes) ? tree.nodes.length : undefined,
        complete: tree.complete, truncated: tree.truncated, readMode: tree.readMode, queryMs: tree.queryMs, readMs: tree.readMs } };
  }
  if (tool === "orbit_handoff_candidates") return { workspace: data.workspace, candidates: Array.isArray(data.candidates)
    ? data.candidates.map(value => { const item = object(value); return { address: item.address, stableId: item.stableId, xwayland: item.xwayland }; }) : undefined };
  if (tool === "orbit_applications") return { truncated: data.truncated, applications: Array.isArray(data.applications)
    ? data.applications.map(value => { const app = object(value); return { id: app.id, registrationIds: app.registrationIds, availability: app.availability, runningPids: app.runningPids }; }) : undefined };
  return data;
}
/** Manual experiment quarantine only, not a production input fence or drain receipt. */
export class ManualAcceptanceBarrier {
  quarantined = false;
  admit(tool: string) {
    if (this.quarantined && ["orbit_open", "orbit_handoff", "orbit_act", "orbit_resume"].includes(tool))
      refuse("Uncertain effect quarantined this experiment; inspect read-only state and do not submit more mutations");
  }
  failure(tool: string) {
    if (["orbit_open", "orbit_handoff", "orbit_act", "orbit_resume"].includes(tool)) this.quarantined = true;
  }
  outcome(tool: string, isError: boolean, data: Fields) {
    if (isError || data.ok === false || data.captureError !== undefined) this.failure(tool);
  }
  mayAutoClose() { return !this.quarantined; }
}

type Opened = { address: string; stableId: string; pid: number; closeAttempted: boolean };
type Owned = { sessionId: string; appId: string; windowId: string; stopped: boolean };

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--run") {
    emit({ event: "usage", manualOnly: true, nativeOperations: false,
      usage: "ORBIT_CONVERSATION_ID=ACTUAL_HOST_CONVERSATION_ID bun experiments/efficiency-native-acceptance.ts --run",
      input: { tool: "orbit_monitors", arguments: {} }, workspace: WORKSPACE, applicationId: APPLICATION });
    if (args.length && !(args.length === 1 && args[0] === "--help")) process.exitCode = 2;
    return;
  }
  if (process.platform !== "linux" || !process.env.ORBIT_CONVERSATION_ID) refuse("Linux and the actual host ORBIT_CONVERSATION_ID are required");
  if (process.env.DSH_SESSION_ID && process.env.ORBIT_CONVERSATION_ID !== process.env.DSH_SESSION_ID)
    refuse("Conversation scope must match this host session, not an invented or alternate scope");
  if (!/^[1-9][0-9]{0,9}$/.test(workspaceSetting) || !Number.isSafeInteger(WORKSPACE) || WORKSPACE > 2147483647)
    refuse("ORBIT_ACCEPTANCE_WORKSPACE must explicitly name a positive numbered workspace");
  // Do not replace HOME, XDG directories, usage state, original profiles or the conversation scope.
  const { ConversationUsage } = await import("../src/conversation-usage");
  const usage = new ConversationUsage();
  await usage.assertEnabled();
  const [{ startBroker }, { createMcpServer }, { localClaim }, { nativeStateRoot }, { Client }, { InMemoryTransport }, { CallToolResultSchema }] = await Promise.all([
    import("../src/ipc"), import("../src/mcp"), import("../src/caller"), import("../src/native-prepare"),
    import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/inMemory.js"), import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const cache = process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), ".cache");
  if (!isAbsolute(cache)) refuse("The normal cache directory must be absolute");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const cacheInfo = await stat(cache);
  if (!cacheInfo.isDirectory() || cacheInfo.uid !== process.getuid?.()) refuse("The normal cache directory must be owned by this user");
  const output = await mkdtemp(join(cache, "orbit-efficiency-acceptance-"));
  const native = nativeStateRoot();
  // Freeze the prepared path. A stale plan must refuse, never auto-load/reload a plugin for this experiment.
  const broker = await startBroker({ native: { planPath: await realpath(join(native, "current", "host.json")), controlDirectory: join(native, "control") } });
  const server = createMcpServer(broker.socket, { claim: localClaim("adapter") });
  const client = new Client({ name: "orbit-manual-efficiency-acceptance", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let counter = 0, stopping = false, opened: Opened | undefined, openingFingerprint: string | undefined;
  const barrier = new ManualAcceptanceBarrier();
  const owned = new Map<string, Owned>();
  let openingBaseline: Fields[] = [];
  const reader = Bun.stdin.stream().getReader();
  const signal = () => { stopping = true; void reader.cancel().catch(() => {}); };
  process.on("SIGINT", signal); process.on("SIGTERM", signal);

  async function invoke(tool: string, arguments_: Fields, event = "result") {
    await usage.assertEnabled();
    barrier.admit(tool);
    try {
    const started = performance.now();
    const result = CallToolResultSchema.parse(await client.callTool({ name: tool, arguments: arguments_ }, CallToolResultSchema, { timeout: 120000 }));
    const durationMs = performance.now() - started;
    const mcpResultBytes = Buffer.byteLength(JSON.stringify(result));
    let data: Fields = {};
    if (result.structuredContent) data = object(result.structuredContent);
    else for (const block of result.content) if (block.type === "text") {
      try { data = object(JSON.parse(block.text)); } catch { data = { text: "Non-JSON MCP text retained only by the MCP caller" }; }
      break;
    }
    barrier.outcome(tool, result.isError === true, data);
    // Track acknowledged identity before artifact IO can fail. Lost replies still
    // remain unresolved; never invent a cleanup binding from a title or PID alone.
    if (tool === "orbit_open" && !result.isError && data.opened === true) {
      if (data.workspace !== WORKSPACE || data.windowProtocol !== "wayland" || !["launch-ancestry", "activation-token"].includes(String(data.identityEvidence))
          || typeof data.address !== "string" || !/^0x[0-9a-f]{1,16}$/.test(data.address) || typeof data.stableId !== "string" || !/^[0-9a-f]{1,16}$/.test(data.stableId)
          || typeof data.pid !== "number" || !Number.isSafeInteger(data.pid) || data.pid <= 0
          || openingBaseline.some(item => item.address === data.address && item.stableId === data.stableId)) refuse("Opening did not prove a new attributed Calculator target");
      if (!opened) opened = { address: data.address, stableId: data.stableId, pid: data.pid, closeAttempted: false };
      else if (opened.address !== data.address || opened.stableId !== data.stableId || opened.pid !== data.pid) refuse("Cached opening identity changed");
    }
    if (tool === "orbit_handoff" && !result.isError) {
      const handoff = object(data.handoff);
      if (typeof data.sessionId !== "string" || typeof handoff.appId !== "string" || !/^[a-f0-9]{32}$/.test(handoff.appId)
          || typeof handoff.selectedWindowId !== "string" || !/^[a-f0-9]{32}$/.test(handoff.selectedWindowId)
          || handoff.workspace !== WORKSPACE || handoff.scope !== "entire-wayland-client") refuse("Handoff did not acknowledge the expected scoped handles");
      owned.set(data.sessionId, { sessionId: data.sessionId, appId: handoff.appId, windowId: handoff.selectedWindowId, stopped: false });
    }
    if (tool === "orbit_stop" && !result.isError)
      for (const session of owned.values()) if (arguments_.scope === "mine" || arguments_.sessionId === session.sessionId) session.stopped = true;
    const sequence = String(++counter).padStart(5, "0"), imagePaths: string[] = [];
    for (const [index, block] of result.content.entries()) if (block.type === "image") {
      if (block.mimeType !== "image/png" || block.data.length > 32 * 1024 * 1024) refuse("Unexpected or oversized native image block");
      const bytes = Buffer.from(block.data, "base64");
      if (bytes.length > 16 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") refuse("Native image block is not a bounded PNG");
      const path = join(output, "capture-" + sequence + "-" + index + ".png");
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); imagePaths.push(path);
    }
    const safe = object(clean(data)), replyPath = join(output, "reply-" + sequence + ".json");
    await writeFile(replyPath, JSON.stringify({ tool, isError: result.isError === true, durationMs, mcpResultBytes, data: safe, imagePaths }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    emit({ event, tool, isError: result.isError === true, durationMs, mcpResultBytes, replyPath, imagePaths, data: compact(tool, safe) });
    return { data, isError: result.isError === true };
    } catch (error) { barrier.failure(tool); throw error; }
  }
  async function candidates(event = "preflight") {
    const reply = await invoke("orbit_handoff_candidates", { workspace: WORKSPACE }, event);
    if (reply.isError || reply.data.workspace !== WORKSPACE || !Array.isArray(reply.data.candidates)) refuse("Candidate inspection was not acknowledged");
    return reply.data.candidates.map(value => {
      const item = object(value);
      if (typeof item.address !== "string" || !/^0x[0-9a-f]{1,16}$/.test(item.address)
          || typeof item.stableId !== "string" || !/^[0-9a-f]{1,16}$/.test(item.stableId)) refuse("Invalid candidate identity");
      return item;
    });
  }
  async function calculator(requireStopped: boolean) {
    const reply = await invoke("orbit_applications", { query: "Calculator" }, "preflight");
    if (reply.isError || reply.data.truncated !== false || !Array.isArray(reply.data.applications)) refuse("Complete Calculator discovery is required");
    const matches = reply.data.applications.map(object).filter(app => app.id === APPLICATION || Array.isArray(app.registrationIds) && app.registrationIds.includes(APPLICATION));
    if (matches.length !== 1) refuse("One verified Calculator registration is required");
    const app = matches[0]!;
    if (app.availability !== "verified" || !Array.isArray(app.runningPids) || app.runningPids.some(pid => typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)) refuse("Calculator process discovery is invalid");
    if (requireStopped && app.runningPids.length !== 0) refuse("Calculator is already running; preserve its original state");
    if (!requireStopped && (!opened || !app.runningPids.includes(opened.pid))) refuse("The attributed Calculator process is no longer acknowledged");
  }
  function active(arguments_: Fields) {
    const session = typeof arguments_.sessionId === "string" ? owned.get(arguments_.sessionId) : undefined;
    if (!session || session.stopped) refuse("Only an acknowledged active controller session may be used");
    return session;
  }
  async function dispatch(value: unknown) {
    const input = object(value);
    if (Object.keys(input).some(key => key !== "tool" && key !== "arguments") || typeof input.tool !== "string" || !allowed.has(input.tool)) refuse("Unknown manual acceptance tool");
    const tool = input.tool, arguments_ = object(input.arguments ?? {});
    barrier.admit(tool);
    if (tool === "orbit_stop" && opened && !opened.closeAttempted && !barrier.quarantined)
      refuse("Close the exact owned window before stopping, or end stdin for bounded owned cleanup");
    if ((tool === "orbit_open" || tool === "orbit_handoff" || tool === "orbit_handoff_candidates") && arguments_.workspace !== WORKSPACE) refuse(`This manual acceptance uses only the explicitly selected workspace ${WORKSPACE}`);
    if (tool === "orbit_open") {
      if (arguments_.applicationId !== APPLICATION || typeof arguments_.requestId !== "string") refuse("Only the exact Calculator registration with a stable requestId may be opened");
      const fingerprint = JSON.stringify(arguments_);
      if (openingFingerprint && fingerprint !== openingFingerprint) refuse("Opening was already attempted; never relaunch an uncertain request");
      if (!openingFingerprint) {
        await calculator(true); openingBaseline = await candidates();
        const display = await invoke("orbit_monitors", {}, "preflight");
        if (display.isError || !Array.isArray(display.data.monitors) || !display.data.monitors.length || display.data.monitors.length > 64)
          refuse("Connected monitor acknowledgement is required before opening");
        const monitors = display.data.monitors.map(object);
        const names = new Set<string>();
        for (const monitor of monitors) {
          if (typeof monitor.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(monitor.name) || names.has(monitor.name)
              || typeof monitor.focused !== "boolean" || !(monitor.workspace === null
                || typeof monitor.workspace === "number" && Number.isSafeInteger(monitor.workspace) && monitor.workspace > 0))
            refuse("Invalid connected monitor acknowledgement");
          names.add(monitor.name);
        }
        if (!monitors.some(monitor => monitor.workspace === WORKSPACE && monitor.focused === false)
            || monitors.some(monitor => monitor.workspace === WORKSPACE && monitor.focused === true))
          refuse(`Workspace ${WORKSPACE} must currently be displayed on an unfocused connected monitor, never the focused monitor`);
        openingFingerprint = fingerprint; // Record before any opening is attempted, including lost replies.
      }
    }
    if (tool === "orbit_handoff") {
      if (!opened || arguments_.address !== opened.address || arguments_.stableId !== opened.stableId) refuse("Handoff must select the exact newly attributed Calculator window");
      if ([...owned.values()].some(session => !session.stopped)) refuse("Reuse the existing controller handoff");
      await calculator(false);
      const fresh = await candidates();
      if (!fresh.some(item => item.address === opened!.address && item.stableId === opened!.stableId && item.xwayland === false)) refuse("The exact newly attributed window is no longer a Wayland candidate");
    }
    if (tool === "orbit_act") {
      const session = active(arguments_);
      const actions = arguments_.actions === undefined ? [arguments_.action] : arguments_.actions;
      if (!Array.isArray(actions) || !actions.length) refuse("Explicit native actions are required");
      for (const value of actions) {
        const action = object(value);
        if (action.appId !== session.appId || (action.type === "windows" ? action.windowId !== undefined : action.windowId !== session.windowId)) refuse("Only the exact acknowledged new Calculator window is an input target");
        if (action.type === "close-application") refuse("Whole-application cleanup is unavailable");
        if (action.type === "close-window") {
          if (!opened || opened.closeAttempted || actions.length !== 1 || arguments_.capture !== undefined) refuse("Do not retry or batch an uncertain exact-window closure");
          opened.closeAttempted = true;
        }
      }
    } else if (["orbit_observe", "orbit_pause", "orbit_resume", "orbit_journal", "orbit_narrow"].includes(tool)) {
      const session = active(arguments_);
      if (tool === "orbit_observe" && ((arguments_.appId !== undefined && arguments_.appId !== session.appId)
          || (arguments_.windowId !== undefined && arguments_.windowId !== session.windowId))) refuse("Observation target differs from the acknowledged Calculator window");
    } else if (tool === "orbit_stop" && arguments_.scope !== "mine") active(arguments_);
    if (tool === "internal_owner_snapshot") {
      await usage.assertEnabled();
      if (Object.keys(arguments_).length) refuse("Owner metadata snapshot takes no arguments");
      const sample: Fields = { sampledAt: new Date().toISOString() };
      for (const command of ["activewindow", "cursorpos", "monitors"]) {
        const child = Bun.spawnSync(["/usr/bin/hyprctl", "-j", command], { timeout: 2000, maxBuffer: 65536 });
        if (child.exitCode !== 0) refuse("Read-only compositor metadata could not be sampled");
        const data: unknown = JSON.parse(child.stdout.toString());
        if (command === "activewindow") { const window = object(data); sample.focus = { address: window.address, pid: window.pid }; }
        else if (command === "cursorpos") { const point = object(data); sample.pointer = { x: point.x, y: point.y }; }
        else {
          if (!Array.isArray(data) || data.length > 64) refuse("Invalid monitor metadata snapshot");
          sample.monitors = data.map(value => { const monitor = object(value), workspace = object(monitor.activeWorkspace);
            return { name: monitor.name, focused: monitor.focused, workspace: workspace.id }; });
        }
      }
      const path = join(output, "owner-" + String(++counter).padStart(5, "0") + ".json");
      await writeFile(path, JSON.stringify(sample, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      emit({ event: "owner-snapshot", ...sample, replyPath: path, scope: "read-only compositor metadata, no window titles/content" });
      return;
    }
    if (tool === "internal_passive_observe") {
      await usage.assertEnabled();
      const binding = active(arguments_);
      if (Object.keys(arguments_).some(key => !["sessionId", "format", "timeoutMs"].includes(key))) refuse("Passive experiment accepts only its own session, format and budget");
      const format = arguments_.format ?? "image", timeoutMs = arguments_.timeoutMs ?? 3000;
      if (!["image", "text", "both"].includes(String(format)) || typeof timeoutMs !== "number"
          || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000) refuse("Invalid passive observation options");
      const { NativeBackend } = await import("../src/hyprland");
      const { decide } = await import("../src/policy");
      const runtime = (Reflect.get(broker.sessions, "sessions") as Map<string, unknown>).get(binding.sessionId);
      const own = object(runtime), backend = own.backend;
      if (own.ownerId !== `conv:${usage.conversationId}` || !["running", "paused"].includes(String(own.state))
          || !(backend instanceof NativeBackend)) refuse("Private controller does not own this live backend");
      if (decide(own.policy as import("../src/policy").SessionPolicy, "observe").outcome !== "allow") refuse("Current policy does not allow passive observation");
      const state = () => JSON.stringify(Object.fromEntries(["selected", "windows", "scales", "pointer", "size"].map(key => {
        const value = Reflect.get(backend, key); return [key, value instanceof Map ? [...value] : value];
      })));
      const before = state(), policy = own.policy, started = performance.now();
      let frame: Fields;
      try { frame = await backend.observePassive({ appId: binding.appId, windowId: binding.windowId }, format as "image" | "text" | "both", timeoutMs); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "EXPERIMENT_FAILED";
        emit({ event: "passive-error", internalOnly: true, code, backendStateUnchanged: before === state(), replayInput: false });
        return;
      }
      await usage.assertEnabled();
      if (own.policy !== policy || !["running", "paused"].includes(String(own.state))) refuse("Observation scope changed before delivery");
      const sequence = String(++counter).padStart(5, "0"), imagePaths: string[] = [];
      if (frame.image !== undefined) {
        if (typeof frame.image !== "string" || frame.image.length > 24 * 1024 * 1024) refuse("Passive image exceeds experiment bounds");
        const bytes = Buffer.from(frame.image, "base64");
        if (bytes.length > 16 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") refuse("Passive frame is not a bounded PNG");
        const path = join(output, "passive-" + sequence + ".png");
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); imagePaths.push(path);
      }
      const safe = object(clean(frame)), replyPath = join(output, "passive-" + sequence + ".json");
      const evidence = { internalOnly: true, layer: "NativeBackend-to-production-worker", durationMs: performance.now() - started,
        backendStateUnchanged: before === state(), observation: frame.observation, data: safe, imagePaths };
      await writeFile(replyPath, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      emit({ event: "passive-result", ...evidence, data: compact("orbit_observe", safe), replyPath });
      return;
    }
    const reply = await invoke(tool, arguments_);
    if (reply.isError) return;
    if (tool === "orbit_handoff") {
      emit({ event: "binding", ...owned.get(String(reply.data.sessionId)), sourceIdentity: opened,
        identityLimit: "PID attributed by opening receipt and fresh application discovery; MCP handoff acknowledges address/stableId selection, not a separate PID field" });
    }
  }
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    emit({ event: "ready", manualOnly: true, workspace: WORKSPACE, outputDirectory: output,
      warmHost: process.env.ORBIT_A11Y_WARM_HOST === "1", conversationScope: "actual-host-id", automaticRetries: false });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    while (!stopping) {
      const next = await reader.read();
      pending += decoder.decode(next.done ? undefined : next.value, { stream: !next.done });
      let newline: number;
      while (!stopping && (newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) refuse("Manual request line exceeds 64 KiB");
        if (!line.trim()) continue;
        try { await dispatch(JSON.parse(line)); }
        catch (error) { emit({ event: "refused", message: error instanceof Refusal ? error.message : "Manual request failed; do not replay uncertain input" }); }
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) refuse("Manual request line exceeds 64 KiB");
      if (next.done) {
        if (!stopping && pending.trim()) {
          try { await dispatch(JSON.parse(pending)); }
          catch (error) { emit({ event: "refused", message: error instanceof Refusal ? error.message : "Manual request failed; do not replay uncertain input" }); }
        }
        break;
      }
    }
  } finally {
    stopping = true;
    const errors: string[] = [];
    if (barrier.quarantined) errors.push("Uncertain effect quarantined the experiment; automatic window closure skipped, inspect exact identity manually");
    if (openingFingerprint && !opened) errors.push("Opening outcome/identity unresolved; no window closure or relaunch was attempted");
    if (opened && !opened.closeAttempted && !owned.size) errors.push("Known new window has no acknowledged handoff; inspect it manually, never guess a cleanup binding");
    for (const session of owned.values()) if (barrier.mayAutoClose() && !session.stopped && opened && !opened.closeAttempted) {
      opened.closeAttempted = true;
      try {
        await usage.assertEnabled();
        const result = await invoke("orbit_act", { sessionId: session.sessionId, requestId: "acceptance-cleanup-" + crypto.randomUUID(),
          action: { type: "close-window", appId: session.appId, windowId: session.windowId } }, "cleanup");
        if (result.isError) errors.push("Exact-window closure was not confirmed; never replay it with a new identity");
      } catch { errors.push("Exact-window closure skipped or uncertain; inspect candidates without blind replay"); }
    }
    try { await invoke("orbit_stop", { scope: "mine" }, "cleanup"); }
    catch { errors.push("MCP stop unavailable; private broker shutdown still releases only its own sessions"); }
    for (const operation of [() => client.close(), () => server.close(), () => broker.close()]) {
      try { await operation(); } catch { errors.push("Private controller cleanup incomplete"); }
    }
    await reader.cancel().catch(() => {});
    process.off("SIGINT", signal); process.off("SIGTERM", signal);
    emit({ event: "closed", errors, quarantined: barrier.quarantined, openingIdentityUnresolved: !!openingFingerprint && !opened,
      ownedWindowNeedsInspection: !!opened && !opened.closeAttempted, outputDirectory: output, windowClosure: "Acknowledgement is not proof of disappearance; inspect native candidates" });
    if (errors.length) process.exitCode = 1;
  }
}

if (import.meta.main) await main().catch(error => {
  emit({ event: "fatal", message: error instanceof Refusal ? error.message : "Manual acceptance controller failed; no automatic retry" });
  process.exitCode = 1;
});
