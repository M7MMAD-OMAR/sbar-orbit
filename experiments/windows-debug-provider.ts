import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { debugNative } from "../tests/windows-debug-native";
import { admitDebugRecord, continuation, duplicateOwner, rootHandoffOwner, helperDeathAuthority, abortRootSafety,
  creatorRootRights, transferBarrier, validateTransferSeal, type TransferSeal, type RootHandoff, type DebugIdentity, type DebugRecord } from "../tests/windows-debug-contract";

const MAX_EVENTS = 8192, MAX_HANDLES = 64, LANE_MS = 20000, CLEANUP_MS = 4000;
const script = resolve(import.meta.path);
const serialized = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const syncPut = (path: string, value: unknown) => {
  const temp = `${path}.pending`; writeFileSync(temp, serialized(value), { flag: "wx" }); renameSync(temp, path);
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// This helper has a dedicated JS thread. All debug API calls are synchronous on that thread.
function producer(directory: string, target: number, session: string) {
  const native = debugNative(), { api, ptr, handle, fail } = native;
  const thread = api.GetCurrentThreadId(), deadline = performance.now() + LANE_MS;
  const threadCheck = () => { if (api.GetCurrentThreadId() !== thread) throw new Error("Debug creator thread changed"); };
  const abortCheck = () => { if (existsSync(join(directory, "abort-request.json"))) throw new Error("Controller requested cooperative abort"); };
  const waitAck = (name: string) => {
    while (!existsSync(join(directory, name))) {
      abortCheck();
      if (performance.now() >= deadline) throw new Error("Absolute producer acknowledgement deadline expired");
      threadCheck(); api.Sleep(5);
    }
  };
  let creator: ReturnType<typeof native.create> | undefined;
  let creationAttempted = false, rootTransfer: RootHandoff | undefined;
  const explicit = duplicateOwner(native.close);
  let sequence = 0, events = 0, continued = 0;
  const processes = new Map<number, { identity: DebugIdentity; initialBreakpoint: boolean; exited: boolean }>();
  let root: DebugIdentity | undefined;
  let killPolicyFalse = false, pendingEvent: { pid: number; tid: number; status: number } | undefined;
  const barrier = transferBarrier(session);
  let sealed = false;
  const transfers: { sequence: number; handle: number; pid: number }[] = [];
  try {
    abortCheck(); creationAttempted = true;
    creator = native.create([process.execPath, script, "--root", directory], directory, true);
    explicit.add(creator.process); explicit.add(creator.thread);
    threadCheck(); if (!api.DebugSetProcessKillOnExit(false)) fail("DebugSetProcessKillOnExit FALSE"); killPolicyFalse = true;
    const rootHandle = native.duplicate(creator.process, target, "creator-root");
    rootTransfer = { pid: creator.pid, handle: rootHandle, session, role: "creator-root", rights: creatorRootRights, killPolicyFalse };
    // Publish ownership before fallible identity work. The helper is already inside
    // the controller's outer containment job, so prepublication failures stay owned.
    syncPut(join(directory, "root-handoff.json"), rootTransfer);
    abortCheck(); root = native.identity(creator.process);
    syncPut(join(directory, "root-creator.json"), { ...rootTransfer, identity: root, thread });
    waitAck("root-assigned");
    if (api.ResumeThread(handle(creator.thread)) === 0xffffffff) fail("Resume private root after assignment");
    explicit.close(); creator = undefined;
    while (performance.now() < deadline) {
      abortCheck();
      threadCheck();
      const sealPath = join(directory, "seal-request.json");
      if (!sealed && existsSync(sealPath)) {
        const request = JSON.parse(readFileSync(sealPath, "utf8"));
        const seal = barrier.seal(request.session); sealed = true;
        syncPut(join(directory, "seal-ack.json"), { ...seal, creatorThread: thread, events, continued });
      }
      const event = new Uint8Array(176), view = new DataView(event.buffer);
      if (!api.WaitForDebugEvent(ptr(event), Math.min(100, Math.max(1, deadline - performance.now())))) {
        if (api.GetLastError() !== 121) fail("WaitForDebugEvent bounded");
        continue;
      }
      const code = view.getUint32(0, true), pid = view.getUint32(4, true), tid = view.getUint32(8, true);
      let status = continuation(code, view.getUint32(16, true), view.getUint32(168, true) !== 0, false);
      pendingEvent = { pid, tid, status };
      if (++events > MAX_EVENTS) throw new Error("Debug event bound exhausted");
      const detail: Record<string, unknown> = { code, pid, tid, thread, ordinal: events };
      if (code === 3) {
        if (processes.has(pid) || processes.size >= MAX_HANDLES) throw new Error("Debug generation conflict or handle bound exhausted");
        const imageFile = Number(view.getBigUint64(16, true)); if (imageFile) explicit.add(imageFile);
        barrier.begin();
        const processHandle = native.number(view.getBigUint64(24, true));
        const identity = native.identity(processHandle), duplicate = native.duplicate(processHandle, target, "observation");
        const transfer = { sequence, handle: duplicate, pid }; transfers.push(transfer); barrier.delivered(transfer);
        syncPut(join(directory, `process-${sequence}.json`), { sequence, pid, handle: duplicate, identity, session, root,
          rights: 0x00101000, immediateParent: "not measured", provenance: "creator-debug-chain", systemManagedProcess: true, systemManagedThread: true });
        waitAck(`process-${sequence}-accepted`); barrier.acknowledged(); sequence++;
        processes.set(pid, { identity, initialBreakpoint: true, exited: false });
        detail.creation = identity;
        if (imageFile) { explicit.close(); detail.imageFileClosed = true; }
      } else if (code === 6) {
        const file = Number(view.getBigUint64(16, true)); if (file) { explicit.add(file); explicit.close(); detail.dllFileClosed = true; }
      } else if (code === 1) {
        const known = processes.get(pid); if (!known) throw new Error("Exception without a known debug generation");
        const first = view.getUint32(168, true) !== 0, exceptionCode = view.getUint32(16, true);
        const initial = known.initialBreakpoint && first && exceptionCode === 0x80000003;
        known.initialBreakpoint = false;
        status = continuation(code, exceptionCode, first, initial); pendingEvent.status = status;
        Object.assign(detail, { exceptionCode, firstChance: first, initialLoaderBreakpointCandidate: initial });
      } else if (code === 5) {
        const known = processes.get(pid); if (!known) throw new Error("Exit without a known debug generation");
        known.exited = true; detail.exitCode = view.getUint32(16, true);
      } else if (![2, 4, 7, 8].includes(code)) throw new Error(`Unsupported debug event ${code}`);
      threadCheck(); if (!api.ContinueDebugEvent(pid, tid, status)) fail("ContinueDebugEvent");
      continued++; pendingEvent = undefined;
      syncPut(join(directory, `event-${events}.json`), { ...detail, continueStatus: status, continued: true });
      if (processes.size >= 2 && [...processes.values()].every(item => item.exited)) {
        syncPut(join(directory, "producer-result.json"), { state: "covered controlled chain drained", events, continued, thread, killPolicyFalse,
          transferred: transfers, root, preciseParentGeneration: "not measured", chainSplit: "not exercised", chromeCoverage: "not measured" });
        return;
      }
    }
    throw new Error("Absolute debug stream deadline expired; coverage not measured");
  } catch (error) {
    const cleanup: string[] = [];
    let creatorExitConfirmed = false;
    if (pendingEvent) {
      try { if (!api.ContinueDebugEvent(pendingEvent.pid, pendingEvent.tid, pendingEvent.status)) fail("Failure event continuation"); }
      catch (failure) { cleanup.push(errorText(failure)); }
    }
    if (creator && explicit.outstanding().includes(creator.process)) {
      // Before assignment acknowledgement this exact creator handle is the only
      // safe cleanup target. Do not exit/detach and abandon a suspended root.
      try {
        if (!api.TerminateProcess(handle(creator.process), 89)) fail("Terminate unacknowledged creator root");
        const cleanupDeadline = performance.now() + CLEANUP_MS;
        while (api.WaitForSingleObject(handle(creator.process), 0) !== 0 && performance.now() < cleanupDeadline) {
          const raw = new Uint8Array(176), view = new DataView(raw.buffer);
          if (!api.WaitForDebugEvent(ptr(raw), 50)) { if (api.GetLastError() !== 121) fail("Drain failed root"); continue; }
          const code = view.getUint32(0, true), pid = view.getUint32(4, true), tid = view.getUint32(8, true);
          if (code === 3 || code === 6) { const file = Number(view.getBigUint64(16, true)); if (file) native.close(file); }
          if (!api.ContinueDebugEvent(pid, tid, continuation(code, view.getUint32(16, true), view.getUint32(168, true) !== 0, false))) fail("Continue failed root cleanup");
        }
        if (api.WaitForSingleObject(handle(creator.process), 0) !== 0) throw new Error("Unacknowledged root cleanup not measured");
        creatorExitConfirmed = true;
      } catch (failure) { cleanup.push(errorText(failure)); }
    }
    try { explicit.close(); } catch (failure) { cleanup.push(errorText(failure)); }
    const adoptedPath = join(directory, "root-adopted.json");
    let controllerAdopted = false;
    if (rootTransfer && existsSync(adoptedPath)) {
      const adopted = JSON.parse(readFileSync(adoptedPath, "utf8"));
      controllerAdopted = adopted.session === session && adopted.handle === rootTransfer.handle && adopted.pid === rootTransfer.pid;
    }
    const rootSafety = abortRootSafety(creationAttempted, creatorExitConfirmed, controllerAdopted);
    syncPut(join(directory, "abort-ack.json"), { session, rootSafety, rootTransfer, transferred: transfers, creatorExitConfirmed,
      stopped: true, noFurtherCreation: true, cleanup, outstandingExplicit: explicit.outstanding() });
    syncPut(join(directory, "producer-result.json"), { state: "not measured", error: errorText(error), cleanup, events, continued,
      killPolicyFalse, root, transferred: transfers, outstandingExplicit: explicit.outstanding() });
    process.exitCode = 1;
  } finally {
    // Inherited controller process handle is explicit. No job handle exists in this process.
    try { native.close(target); } catch { process.exitCode = 1; }
    native.dispose();
  }
}

async function child(directory: string) {
  await writeFile(join(directory, "grandchild-ready"), String(process.pid), { flag: "wx" });
  const deadline = performance.now() + LANE_MS;
  while (!existsSync(join(directory, "release"))) { if (performance.now() >= deadline) process.exit(9); await Bun.sleep(5); }
}

async function rootChild(directory: string) {
  const native = debugNative(), created = native.create([process.execPath, script, "--grandchild", directory], directory, false);
  const creator = duplicateOwner(native.close); creator.add(created.process); creator.add(created.thread);
  try {
    if (native.api.ResumeThread(native.handle(created.thread)) === 0xffffffff) native.fail("Resume private grandchild");
    creator.close();
    await writeFile(join(directory, "root-ready"), String(process.pid), { flag: "wx" });
    const deadline = performance.now() + LANE_MS;
    while (!existsSync(join(directory, "release"))) { if (performance.now() >= deadline) process.exit(9); await Bun.sleep(5); }
  } finally { creator.close(); native.dispose(); }
}

async function controllerLane(mode: "job-close" | "debugger-death", parent: string) {
  const directory = join(parent, mode); mkdirSync(directory);
  const native = debugNative(), { api, ptr, handle, fail } = native;
  const owner = duplicateOwner(native.close), deadline = performance.now() + LANE_MS;
  const session = `${mode}-${crypto.randomUUID()}`;
  let job: number | undefined, containmentJob: number | undefined, helper: ReturnType<typeof native.create> | undefined;
  let helperResumed = false, helperContained = false;
  let transferSeal: TransferSeal | undefined;
  let root: DebugIdentity | undefined, next = 0, rootAssigned = false, rootHandle: number | undefined;
  const handoff = rootHandoffOwner(session, processHandle => owner.add(processHandle));
  const records: DebugRecord[] = [], evidence: Record<string, unknown> = { mode, session, state: "not measured" };
  const member = (processHandle: number, jobHandle = job) => {
    if (jobHandle === undefined) throw new Error("Job handle unavailable");
    const yes = new Uint32Array(1); if (!api.IsProcessInJob(handle(processHandle), handle(jobHandle), ptr(yes))) fail("Exact event handle job membership");
    return yes[0] === 1;
  };
  const adoptPublishedRoot = async () => {
    const path = join(directory, "root-handoff.json");
    if (!handoff.held() && existsSync(path)) {
      const row = JSON.parse(await readFile(path, "utf8"));
      const held = handoff.adopt(row); rootHandle = held.handle;
      evidence.rootHandoff = held;
      await writeFile(join(directory, "root-adopted.json"), serialized({ session, handle: held.handle, pid: held.pid }), { flag: "wx" });
      if (!member(held.handle, containmentJob)) throw new Error("Creator root outer containment is unknown");
      evidence.rootOuterContainment = true;
    }
  };
  const pump = async () => {
    await adoptPublishedRoot();
    const rootPath = join(directory, "root-creator.json");
    if (!rootAssigned && existsSync(rootPath)) {
      const row = JSON.parse(await readFile(rootPath, "utf8")), held = handoff.held();
      if (!held || row.handle !== held.handle || row.pid !== held.pid || row.session !== session || row.killPolicyFalse !== true || job === undefined)
        throw new Error("Root creator provenance unknown");
      // Ownership already exists even if either identity query below fails.
      root = native.identity(row.handle);
      if (api.GetProcessId(handle(row.handle)) !== row.pid) throw new Error("Root creator handle PID mismatch");
      if (serialized(root) !== serialized(row.identity)) throw new Error("Creator identity substitution");
      if (!api.AssignProcessToJobObject(handle(job), handle(row.handle))) fail("Assign exact root before debug continuation");
      if (!member(row.handle)) throw new Error("Root containment unknown");
      rootAssigned = true; await writeFile(join(directory, "root-assigned"), "assigned", { flag: "wx" });
      evidence.creatorReceipt = row;
    }
    while (existsSync(join(directory, `process-${next}.json`))) {
      const row = JSON.parse(await readFile(join(directory, `process-${next}.json`), "utf8")); owner.add(row.handle);
      if (!root || row.sequence !== next) throw new Error("Debug transfer sequence unknown");
      const actual = native.identity(row.handle);
      if (api.GetProcessId(handle(row.handle)) !== row.pid) throw new Error("Event process handle PID mismatch");
      if (serialized(actual) !== serialized(row.identity)) throw new Error("Event handle identity mismatch");
      records.push(admitDebugRecord({ ...row, jobMember: member(row.handle) }, session, root));
      await writeFile(join(directory, `process-${next}-accepted`), "accepted", { flag: "wx" }); next++;
    }
    if (performance.now() >= deadline) throw new Error("Absolute controller capture deadline expired");
    const result = join(directory, "producer-result.json");
    if (existsSync(result) && JSON.parse(await readFile(result, "utf8")).state === "not measured") throw new Error("Producer failure retained");
  };
  const wait = async (ready: () => boolean) => { while (!ready()) { await pump(); await Bun.sleep(5); } await pump(); };
  try {
    containmentJob = native.number(api.CreateJobObjectW(null, null));
    const containmentLimits = new Uint8Array(144); new DataView(containmentLimits.buffer).setUint32(16, 0x2000, true);
    if (!api.SetInformationJobObject(handle(containmentJob), 9, ptr(containmentLimits), containmentLimits.length)) fail("Set outer owned no-breakaway containment");
    job = native.number(api.CreateJobObjectW(null, null)); const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, 0x2000, true);
    if (!api.SetInformationJobObject(handle(job), 9, ptr(limits), limits.length)) fail("Set private kill-on-close with no breakaway");
    const controller = native.controllerTransferHandle(); owner.add(controller);
    helper = native.create([process.execPath, script, "--producer", directory, String(controller), session], directory, false, controller);
    owner.add(helper.process); owner.add(helper.thread);
    if (!api.AssignProcessToJobObject(handle(containmentJob), handle(helper.process))) fail("Assign exact suspended helper to outer containment");
    if (!member(helper.process, containmentJob)) throw new Error("Helper outer containment is unknown");
    helperContained = true; evidence.helperOuterContainment = true;
    if (member(helper.process)) throw new Error("Debugger helper unexpectedly belongs to the private debuggee job");
    evidence.helperOutsidePrivateJob = true;
    if (api.ResumeThread(handle(helper.thread)) === 0xffffffff) fail("Resume owned debugger helper");
    helperResumed = true;
    await wait(() => records.length === 2 && existsSync(join(directory, "root-ready")) && existsSync(join(directory, "grandchild-ready")));
    const readyRoot = Number(await readFile(join(directory, "root-ready"), "utf8"));
    const readyChild = Number(await readFile(join(directory, "grandchild-ready"), "utf8"));
    if (readyRoot === readyChild || !records.some(record => record.pid === readyRoot && serialized(record.identity) === serialized(root)) ||
      !records.some(record => record.pid === readyChild)) throw new Error("Controlled readiness generation set mismatch");
    if (records.some(record => native.state(record.handle).state !== "alive")) throw new Error("Gated debuggees were not alive");
    await writeFile(join(directory, "seal-request.json"), serialized({ session }), { flag: "wx" });
    await wait(() => existsSync(join(directory, "seal-ack.json")));
    const seal = JSON.parse(await readFile(join(directory, "seal-ack.json"), "utf8"));
    validateTransferSeal(seal, session, records);
    if (seal.creatorThread !== (evidence.creatorReceipt as { thread: number }).thread || seal.events !== seal.continued)
      throw new Error("Creator-thread seal continuation barrier unknown");
    transferSeal = seal; evidence.transferSeal = seal;
    evidence.records = records; evidence.before = records.map(record => ({ pid: record.pid, ...native.state(record.handle) }));
    if (mode === "job-close") {
      if (native.state(helper.process).state !== "alive") throw new Error("Debugger not alive before job closure");
      native.close(job); job = undefined; evidence.jobClosedBeforeExit = true;
      await wait(() => existsSync(join(directory, "producer-result.json")));
      const result = JSON.parse(await readFile(join(directory, "producer-result.json"), "utf8"));
      if (result.state !== "covered controlled chain drained" || result.events !== result.continued || !result.killPolicyFalse) throw new Error("Debug stream completion unknown");
      evidence.producer = result;
    } else {
      if (!api.TerminateProcess(handle(helper.process), 77)) fail("Terminate only owned debugger helper");
      const stoppedHelperProcess = helper.process;
      await wait(() => native.state(stoppedHelperProcess).state === "exited");
      if (records.some(record => native.state(record.handle).state !== "alive" || !member(record.handle))) throw new Error("Debugger death masked by child exit or containment loss");
      evidence.afterDebuggerDeath = records.map(record => ({ pid: record.pid, ...native.state(record.handle), jobMember: member(record.handle) }));
      await writeFile(join(directory, "release"), "natural exit", { flag: "wx" });
    }
    await wait(() => records.every(record => native.state(record.handle).state === "exited"));
    evidence.after = records.map(record => ({ pid: record.pid, ...native.identity(record.handle), ...native.state(record.handle) }));
    if (mode === "debugger-death" && records.some(record => native.state(record.handle).exitCode !== 0)) throw new Error("Natural exit after debugger death not measured");
    evidence.state = "controlled lane measured";
  } catch (error) { evidence.error = errorText(error); }
  finally {
    const cleanup: string[] = [], cleanupDeadline = performance.now() + CLEANUP_MS;
    let processCleanup = false, transferCoverage = transferSeal !== undefined;
    const registerTransfers = (rows: { handle: number; sequence: number; pid: number }[]) => {
      if (!Array.isArray(rows) || rows.length > MAX_HANDLES) throw new Error("Abort transfer inventory unknown");
      for (const row of rows) {
        if (!Number.isSafeInteger(row.handle) || row.handle <= 0 || !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
          !Number.isSafeInteger(row.sequence) || row.sequence < 0) throw new Error("Abort transfer row unknown");
        if (!owner.outstanding().includes(row.handle)) owner.add(row.handle);
      }
    };
    try {
      let abortSafe = false;
      if (helper && helperResumed && native.state(helper.process).state === "alive") {
        await writeFile(join(directory, "abort-request.json"), serialized({ session }), { flag: "wx" });
        const grace = Math.min(cleanupDeadline, performance.now() + 2000);
        while (performance.now() < grace && native.state(helper.process).state === "alive") {
          await adoptPublishedRoot();
          const ackPath = join(directory, "abort-ack.json");
          if (existsSync(ackPath)) {
            const ack = JSON.parse(await readFile(ackPath, "utf8"));
            if (ack.session !== session || ack.stopped !== true || ack.noFurtherCreation !== true)
              throw new Error("Cooperative abort acknowledgement unknown");
            if (ack.rootTransfer && !handoff.held()) {
              const held = handoff.adopt(ack.rootTransfer); rootHandle = held.handle;
            }
            registerTransfers(ack.transferred);
            transferCoverage = true;
            abortSafe = ["exact creator root exited", "controller owns exact root", "root creation never started"].includes(ack.rootSafety);
            evidence.abortAcknowledgement = ack;
            break;
          }
          await Bun.sleep(5);
        }
      }
      // Never kill an unreconciled creator first. The pre-resume outer job owns
      // every helper-created process, including an unpublished suspended root.
      if (helper && native.state(helper.process).state === "alive") {
        if (!helperResumed || helperDeathAuthority(handoff.held() !== undefined, abortSafe)) {
          if (!api.TerminateProcess(handle(helper.process), 88)) fail("Terminate reconciled owned helper");
          evidence.helperCleanupAuthority = !helperResumed ? "helper never resumed" : "exact root reconciled";
        } else {
          if (!helperContained || containmentJob === undefined) throw new Error("Unreconciled creator containment unknown");
          if (!api.TerminateJobObject(handle(containmentJob), 88)) fail("Terminate unreconciled owned outer job");
          evidence.helperCleanupAuthority = "owned outer containment fallback";
        }
      }
      if (job !== undefined && !api.TerminateJobObject(handle(job), 88)) fail("Terminate measurement cleanup job");
      if (containmentJob !== undefined && !api.TerminateJobObject(handle(containmentJob), 88)) fail("Terminate outer cleanup job");
      if (rootHandle !== undefined && !rootAssigned && native.state(rootHandle).state === "alive") {
        if (!api.TerminateProcess(handle(rootHandle), 88)) fail("Terminate exact unassigned creator root");
      }
      const active = (jobHandle: number) => {
        const accounting = new Uint8Array(48);
        if (!api.QueryInformationJobObject(handle(jobHandle), 1, ptr(accounting), accounting.length, null)) fail("Owned cleanup job accounting");
        return new DataView(accounting.buffer).getUint32(40, true);
      };
      while (performance.now() < cleanupDeadline &&
        ((helper && native.state(helper.process).state !== "exited") ||
        records.some(record => native.state(record.handle).state !== "exited") ||
        (rootHandle !== undefined && native.state(rootHandle).state !== "exited") ||
        (job !== undefined && active(job) !== 0) || (containmentJob !== undefined && active(containmentJob) !== 0))) await Bun.sleep(5);
      if ((helper && native.state(helper.process).state !== "exited") ||
        records.some(record => native.state(record.handle).state !== "exited") ||
        (rootHandle !== undefined && native.state(rootHandle).state !== "exited") ||
        (job !== undefined && active(job) !== 0) || (containmentJob !== undefined && active(containmentJob) !== 0))
        throw new Error("Owned process or job cleanup remains unknown");
      processCleanup = true; evidence.finalJobAccountingActive = 0; evidence.finalOuterAccountingActive = 0;
      if (job !== undefined) { native.close(job); job = undefined; }
      if (containmentJob !== undefined) { native.close(containmentJob); containmentJob = undefined; }
      owner.close();
    } catch (error) { cleanup.push(errorText(error)); }
    // A failed CloseHandle stays retryable, but only after exact process cleanup.
    for (let attempt = 0; processCleanup && owner.outstanding().length && attempt < 3 && performance.now() < cleanupDeadline; attempt++) {
      try { owner.close(); } catch (error) { cleanup.push(errorText(error)); }
    }
    evidence.cleanup = { confirmed: cleanup.length === 0 && processCleanup && transferCoverage && owner.outstanding().length === 0 &&
      job === undefined && containmentJob === undefined,
      processCleanup, transferCoverage: transferCoverage ? "confirmed controlled transfer inventory" : "unknown",
      errors: cleanup, outstanding: owner.outstanding(), jobHandleStillOwned: job !== undefined, outerJobHandleStillOwned: containmentJob !== undefined };
    if (processCleanup && owner.outstanding().length === 0 && job === undefined && containmentJob === undefined) native.dispose();
  }
  await writeFile(join(directory, "lane-report.json"), serialized(evidence), { flag: "wx" });
  return evidence;
}

const [mode, directory, target, session] = process.argv.slice(2);
if (mode === "--producer" && directory && target && session) producer(directory, Number(target), session);
else if (mode === "--root" && directory) await rootChild(directory);
else if (mode === "--grandchild" && directory) await child(directory);
else {
  const output = mode; if (!output) throw new Error("Exclusive output JSON path required");
  if (existsSync(output)) throw new Error("Owned output already exists; no native attempt started");
  const privateRoot = await mkdtemp(join(dirname(resolve(output)), "owned-debug-"));
  const report: Record<string, unknown> = { state: "not measured", capability: "unknown", chromeCoverage: "not measured", performance: "not measured",
    limit: "Two controlled Bun debug-chain lanes only. Production collector unchanged; complete Chrome requirement remains open.", privateRoot };
  try {
    const lanes = [await controllerLane("job-close", privateRoot), await controllerLane("debugger-death", privateRoot)]; report.lanes = lanes;
    const pass = lanes.every(lane => lane.state === "controlled lane measured" && (lane.cleanup as { confirmed?: boolean }).confirmed === true);
    report.state = pass ? "controlled Bun debug feasibility measured" : "not measured";
    await writeFile(output, serialized(report), { flag: "wx" });
    console.log(JSON.stringify({ total: 2, failed: pass ? 0 : 1, skipped: 0, capability: "unknown", chromeCoverage: "not measured" }));
    if (!pass) process.exitCode = 1;
    // Raw private lane evidence is intentionally retained for artifact upload.
  } catch (error) {
    report.error = errorText(error); await writeFile(output, serialized(report), { flag: "wx" }); process.exitCode = 1;
  }
}
