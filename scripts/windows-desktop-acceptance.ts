/** Hosted Windows CI only. Real OS/IPC/task/health; unpublished offline activation fixtures, not feed eligibility. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyExclusiveTree } from "./package-windows";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBroker, call } from "../src/ipc";
import { managedUpdateRoot, requireUpdateAdmission } from "../src/update-admission";
import { withUpdateLock } from "../src/update-lock";
import { sealRelease, sameBrokerIdentity, preparedIdentity, type BrokerIdentity } from "../src/managed-identity";
import { currentVersion, pruneVersions } from "../src/update";
import { admittedWindowsBootstrap, recordWindowsReleaseFiles, verifyWindowsCurrent } from "../src/windows-managed-install";
import { DESKTOP_EXE, DESKTOP_LAUNCHER, DESKTOP_MANIFEST, DESKTOP_RUNTIME, desktopSourceDigest, parseDesktopManifest, validateDesktopPayload, windowsFileDigest } from "../src/windows-desktop-update";
import { boundedCommand } from "../src/lifecycle-command";
import { DEPENDENCY_INVENTORY } from "../src/windows-dependencies";
import { registeredTaskXml, currentUserSid, taskNameForUser } from "../src/windows-autostart";
import { taskOwned } from "../src/managed-lifecycle";
import { serviceSocketPath } from "../src/service";
import { requireResourceBudget } from "../src/resource-budget";
import { parseRuntimeSource, materializeWindowsRuntime } from "../src/windows-runtime-source";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new Error(message); };
const check = (condition: unknown, message: string): void => { if (!condition) fail(message); };
const missing = async (path: string) => !(await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; }));
export function fixtureVersions(base: string, run: string) {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(base) || !/^[0-9]+$/.test(run)) fail("Exact base version and hosted run identifier required");
  check(!/[\r\n]/.test(base + run), "Version/run identifiers cannot contain line breaks");
  const parts = base.split("-")[0]!.split("."), patch = Number(parts[2]);
  check(Number.isSafeInteger(patch) && patch < 65534, "Fixture assembly patch must fit a real Windows version");
  const prefix = parts[0] + "." + parts[1] + "." + String(patch + 1);
  return { activation: prefix + "-ci.activation." + run, rollback: prefix + "-ci.rollback." + run };
}
function hostedWindows() {
  check(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true", "This acceptance program requires its dedicated hosted Windows CI account");
}
async function json(path: string) {
  const info = await lstat(path); check(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, "Bounded owned JSON required");
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}
async function save(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
async function regularTree(directory: string, prefix = "", depth = 0): Promise<string[]> {
  check(depth < 64, "Owned fixture depth exceeded"); const paths: string[] = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? prefix + "/" + name : name, info = await lstat(join(directory, path));
    check(!info.isSymbolicLink(), "No symlinks or reparse fixture payloads");
    if (info.isDirectory()) paths.push(...await regularTree(directory, path, depth + 1));
    else { check(info.isFile(), "Regular owned payload files required"); paths.push(path); }
    check(paths.length <= 20000, "Owned fixture file bound exceeded");
  }
  return paths;
}
async function assertPE(path: string) {
  const file = Bun.file(path); check(file.size > 2 && await file.slice(0, 2).text() === "MZ", "A real compiled Windows PE is required, not a renamed archive");
}
async function maintenanceModuleAudit(payload: string) {
  const seen = new Set<string>();
  async function visit(path: string) {
    check(path.startsWith(payload + sep) && !path.includes(sep + "packaging" + sep), "Runtime maintenance must not depend on excluded packaging files");
    if (seen.has(path)) return; seen.add(path); check(seen.size < 2000, "Maintenance module closure bound exceeded");
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(/(?:from\s*|import\(\s*)["']([.][^"']+)["']/g)) {
      const name = resolve(dirname(path), match[1]!);
      const candidates = [name, name + ".ts", name + ".js", join(name, "index.ts")];
      let actual: string | undefined;
      for (const candidate of candidates) if (!(await missing(candidate)) && (await lstat(candidate)).isFile()) { actual = candidate; break; }
      check(actual, "NPM runtime maintenance relative module is missing"); await visit(actual!);
    }
  }
  await visit(join(payload, "src/windows-managed-install.ts"));
  return { modulesChecked: seen.size, allRelativeRuntimeModulesBundled: true, excludedPackagingDependency: false, installerPowerShellIsExternalOnly: true };
}
/** Read-only failure evidence: never starts, stops, registers or repairs anything. */
async function inspectFailure(options: Map<string, string>) {
  hostedWindows();
  const root = resolve(required(options, "--root")), report = resolve(required(options, "--report"));
  const runnerTemp = process.env.RUNNER_TEMP;
  check(runnerTemp && root === resolve(managedUpdateRoot()) && report.startsWith(resolve(runnerTemp) + sep) && report.endsWith(".json"), "Only the known hosted root and owned evidence report are inspectable");
  const parent = dirname(report), parentInfo = await lstat(parent);
  check(parentInfo.isDirectory() && !parentInfo.isSymbolicLink() && await realpath(parent) === parent && await missing(report), "Exclusive canonical inspector result required");
  const task: Record<string, unknown> = { queryCompleted: false, taskQueryStage: "sid", queryFailureKind: "unobserved", found: null, state: "unknown", lastTaskResult: null, lastRunTimeSeen: null, queryHResult: null, exactOwnership: false };
  const evidence: Record<string, unknown> = { schema: 1, kind: "owned-read-only-install-failure", contentFree: true, mutationsAttempted: false,
    expectedSourceIdentityValid: false, sourceIdentityResult: "unobserved", launchAdmission: "unobserved", recoveryBarrierPresent: false, task, socketPresent: null, endpoint: "unclassified", doctorIdentity: "unobserved", inspectorComplete: false };
  let expectedIdentity: BrokerIdentity | null = null;
  try {
    const info = await lstat(root);
    check(info.isDirectory() && !info.isSymbolicLink() && await realpath(root) === root, "Known root is redirected");
    evidence.recoveryBarrierPresent = !(await missing(join(root, "activation-recovery.json")));
    const version = required(options, "--version");
    try {
      const selected = await verifyWindowsCurrent(root);
      check(selected.version === version, "Observed current version differs from owned fixture");
      expectedIdentity = selected.identity; evidence.expectedSourceIdentityValid = true; evidence.sourceIdentityResult = "valid"; evidence.launchAdmission = "open";
    } catch (error) {
      evidence.launchAdmission = error instanceof Error && error.message === "Managed admission is closed pending recovery; new launches are refused" ? "admission-blocked" : "unclassified-refusal";
      try {
        const pointer = join(root, "current.txt"), info = await lstat(pointer);
        check(info.isFile() && !info.isSymbolicLink() && info.size <= 32768, "Bounded regular current pointer required");
        const directory = join(root, "versions", version), target = (await readFile(pointer, "utf8")).replace(/\r?\n$/, "");
        check(target === directory && resolve(target) === target, "Only the exact expected current version is inspectable");
        const identity = await preparedIdentity(root, version);
        check(identity.runtime === join(directory, DESKTOP_RUNTIME), "Expected versioned runtime differs");
        await validateDesktopPayload(directory, version, await desktopSourceDigest(directory));
        expectedIdentity = { ...identity, root, directory }; evidence.expectedSourceIdentityValid = true; evidence.sourceIdentityResult = "valid-bytes-without-launch-admission";
      } catch (identityError) {
        evidence.sourceIdentityResult = identityError instanceof Error && identityError.message === "Prepared release or runtime bytes changed; migrate deliberately" ? "byte-failure" : "identity-unproven";
      }
    }
    try {
      task.taskQueryStage = "sid";
      const sid = await currentUserSid(), name = taskNameForUser(sid);
      task.taskQueryStage = "command";
      const code = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';$InformationPreference='SilentlyContinue';try{$service=New-Object -ComObject 'Schedule.Service';$service.Connect();$folder=$service.GetFolder([string][char]92);$task=$folder.GetTask('" + name.replaceAll("'", "''") + "');[pscustomobject]@{found=$true;state=[int]$task.State;lastTaskResult=[long]$task.LastTaskResult;lastRunTimeSeen=($task.LastRunTime.Year -gt 1900);xml=[string]$task.Xml;queryHResult=$null}|ConvertTo-Json -Compress -Depth 3}catch{$failure=$_.Exception;while($null -ne $failure.InnerException){$failure=$failure.InnerException};[pscustomobject]@{found=$null;state=0;lastTaskResult=$null;lastRunTimeSeen=$null;xml='';queryHResult=[int]$failure.HResult}|ConvertTo-Json -Compress}";
      const query = await boundedCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], 10000);
      if (!query.ok) {
        task.queryFailureKind = query.stopUnconfirmed === true && query.output === "Lifecycle command timed out; command exit is not confirmed" ? "stop-unconfirmed" : !query.stopUnconfirmed && query.output === "Lifecycle command timed out" ? "timeout" : "failed";
      } else {
        task.taskQueryStage = "parse";
        const value: unknown = JSON.parse(query.output);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const data = value as Record<string, unknown>;
          task.queryCompleted = true; task.queryFailureKind = "none";
          if (data.found === true) {
            task.found = true;
            const states = new Map([[0, "unknown"], [1, "disabled"], [2, "queued"], [3, "ready"], [4, "running"]]);
            task.state = typeof data.state === "number" ? states.get(data.state) ?? "unknown" : "unknown";
            if (typeof data.lastTaskResult === "number" && Number.isSafeInteger(data.lastTaskResult) && data.lastTaskResult >= -2147483648 && data.lastTaskResult <= 4294967295) task.lastTaskResult = data.lastTaskResult;
            if (typeof data.lastRunTimeSeen === "boolean") task.lastRunTimeSeen = data.lastRunTimeSeen;
            if (typeof data.xml === "string" && data.xml.length <= 65536) task.exactOwnership = taskOwned(data.xml, join(root, "bin/sbar-orbit.cmd"), sid);
          }
          if (typeof data.queryHResult === "number" && Number.isSafeInteger(data.queryHResult) && data.queryHResult >= -2147483648 && data.queryHResult <= 2147483647) task.queryHResult = data.queryHResult;
          task.taskQueryStage = "complete";
        } else task.queryFailureKind = "invalid-json";
      }
    } catch { task.queryFailureKind = task.taskQueryStage === "sid" ? "sid-failed" : task.taskQueryStage === "parse" ? "invalid-json" : "failed"; /* Unknown remains unknown, never absent. */ }
    const socket = serviceSocketPath();
    try { evidence.socketPresent = !(await missing(socket)); } catch { evidence.socketPresent = null; }
    const signal = AbortSignal.timeout(5000);
    try {
      const doctor = await call(socket, "doctor", {}, signal);
      evidence.doctorIdentity = doctor && typeof doctor === "object" && "managedIdentity" in doctor ? doctor.managedIdentity === null ? "null" : "non-null" : "absent";
      evidence.endpoint = expectedIdentity && doctor && typeof doctor === "object" && "managedIdentity" in doctor
        && sameBrokerIdentity(doctor.managedIdentity, expectedIdentity) ? "identity-match" : "identity-mismatch";
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
      evidence.endpoint = signal.aborted ? "timeout" : ["ENOENT", "FailedToOpenSocket"].includes(code) ? "missing"
        : ["ECONNREFUSED", "ConnectionRefused", "UNAUTHORIZED", "FORBIDDEN", "AUTH_REQUIRED", "ORBIT_DISABLED"].includes(code) ? "refused" : "unclassified";
    }
    evidence.inspectorComplete = true;
  } catch { /* Keep the primary installer failure; the partial record contains no private exception text. */ }
  const text = JSON.stringify(evidence, null, 2) + "\n";
  check(Buffer.byteLength(text) <= 8192, "Failure inspector output bound exceeded");
  await writeFile(report, text, { flag: "wx", mode: 0o600 });
}

async function ownGui(desktopPath: string, output: string, expected: string) {
  await assertPE(desktopPath);
  const result = await boundedCommand([desktopPath, "--smoke-output", output], 60000);
  check(result.ok, "Owned native GUI did not complete its bounded smoke");
  const proof = await json(join(output, "smoke.json"));
  check(proof.nativeWindow === true && proof.visible === true && proof.version === expected && proof.desktopControl === "unsupported", "Actual native handle, visibility, version and unsupported-control evidence required");
  check(!(await missing(join(output, "orbit-window.png"))), "Actual owned WebView surface screenshot missing");
  return proof;
}
async function processImage(pid: number) {
  check(Number.isSafeInteger(pid) && pid > 0, "Owned compiled transport PID missing");
  const code = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "'; if($p){@{pid=$p.ProcessId;image=$p.ExecutablePath;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}else{'null'}";
  const result = await boundedCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], 10000);
  check(result.ok, "Real owned process image/start probe failed");
  return JSON.parse(result.output) as { pid: number; image: string; created: string } | null;
}

async function adapterChildren(parent: number, runtime: string) {
  const code = "$ErrorActionPreference='Stop'; @(@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=" + parent + "')|ForEach-Object {@{pid=$_.ProcessId;image=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().ToString('o')}})|ConvertTo-Json -Compress";
  const result = await boundedCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], 10000);
  check(result.ok, "Actual owned adapter descendant probe failed");
  const parsed: unknown = JSON.parse(result.output || "[]"), records = Array.isArray(parsed) ? parsed : [parsed];
  check(records.length <= 16, "Unexpected owned adapter process tree size");
  const children = records.filter((entry): entry is { pid: number; image: string; created: string } => !!entry && typeof entry === "object"
    && typeof entry.pid === "number" && typeof entry.image === "string" && typeof entry.created === "string" && entry.image.toLowerCase() === runtime.toLowerCase());
  check(children.length > 0, "Mapped compiled host did not expose its actual owned Bun adapter child");
  return children;
}
async function probe(report: string) {
  const root = resolve(managedUpdateRoot());
  check(await missing(root), "Dedicated CI default managed root already exists; preserve it and refuse this run");
  const account = await mkdtemp(join(tmpdir(), "orbit-ci-ipc-"));
  const broker = await startBroker({ accountRoot: account });
  try {
    const doctor = await call(broker.socket, "doctor", {}, AbortSignal.timeout(5000));
    check(doctor && typeof doctor === "object", "Actual Windows default IPC doctor roundtrip failed");
    const pkg = await json(resolve(import.meta.dir, "../package.json"));
    await save(report, { schema: 1, ok: true, platform: process.platform, root, baseVersion: pkg.version,
      versions: fixtureVersions(String(pkg.version), process.env.GITHUB_RUN_ID ?? ""), actualDefaultIpc: true, nativeApplicationControl: "unsupported", simulated: false });
  } finally { await broker.close(); }
  check(await missing(root), "Private IPC probe unexpectedly created the managed install root");
}

async function prepare(options: Map<string, string>) {
  const base = resolve(required(options, "--base")), gui = resolve(required(options, "--gui"));
  const launcher = resolve(required(options, "--launcher")), output = resolve(required(options, "--destination"));
  const evidence = resolve(required(options, "--evidence")), version = required(options, "--version");
  const pkg = await json(join(base, "package.json")), versions = fixtureVersions(String(pkg.version), process.env.GITHUB_RUN_ID ?? "");
  check(version === versions.activation || version === versions.rollback, "Only explicitly unpublished CI versions are permitted");
  check(await missing(output) && !output.startsWith(resolve(managedUpdateRoot()) + sep) && output !== base && !base.startsWith(output + sep), "Exclusive outside-root fixture destination required");
  await regularTree(base); await regularTree(gui); await assertPE(join(gui, "Orbit.Desktop.exe")); await assertPE(launcher);
  await mkdir(output);
  const omitted = new Set(["SOURCE-COMMIT.json", "SOURCE-COMMIT", "orbit-release-identity.json", "windows-release-files.json"]);
  await copyExclusiveTree(base, output, { exclude: omitted });
  const annotation: Record<string, unknown>[] = [];
  for (const name of ["SOURCE-COMMIT.json", "SOURCE-COMMIT"]) if (!(await missing(join(base, name)))) {
    const bytes = await readFile(join(base, name));
    await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, version + "-" + name + ".original"), bytes);
    annotation.push({ path: name, sha256: hash(bytes), value: name.endsWith(".json") ? JSON.parse(bytes.toString("utf8")) : bytes.toString("utf8") });
  }
  pkg.version = version; await save(join(output, "package.json"), pkg);
  const oldGui = join(output, "desktop/windows-app");
  check(oldGui.startsWith(output + sep) && oldGui !== output && !(await lstat(oldGui)).isSymbolicLink(), "Owned fixture GUI replacement escaped destination");
  await rm(oldGui, { recursive: true });
  await mkdir(oldGui);
  await copyExclusiveTree(gui, oldGui, { pathPrefix: "desktop/windows-app" });
  await copyFile(launcher, join(output, DESKTOP_LAUNCHER), constants.COPYFILE_EXCL);
  await copyFile(join(base, "desktop/windows-app/Orbit.RuntimeBootstrap.exe"), join(output, "desktop/windows-app/Orbit.RuntimeBootstrap.exe"), constants.COPYFILE_EXCL);
  await copyFile(join(base, DEPENDENCY_INVENTORY), join(output, DEPENDENCY_INVENTORY), constants.COPYFILE_EXCL);
  const intentionalFailure = version === versions.rollback;
  if (intentionalFailure) {
    const path = join(output, "src/cli.ts"), original = await readFile(path, "utf8");
    const position = original.startsWith("#!") ? original.indexOf("\n") + 1 : 0;
    await writeFile(path, original.slice(0, position) + 'if (process.argv[2] === "serve") throw new Error("Owned CI rollback fixture intentionally refuses broker startup");\n' + original.slice(position));
  }
  const sourceRevision = process.env.GITHUB_SHA ?? ""; check(/^[a-f0-9]{40}$/.test(sourceRevision), "Real base source revision required");
  const files: { path: string; sha256: string }[] = [];
  for (const path of await regularTree(output)) if (path.startsWith("desktop/windows-app/") || path === DESKTOP_RUNTIME)
    files.push({ path, sha256: await windowsFileDigest(join(output, path)) });
  const runtimeSource = parseRuntimeSource((await json(join(base, DESKTOP_MANIFEST))).runtimeSource);
  files.push({ path: DESKTOP_RUNTIME, sha256: runtimeSource.executableSha256 });
  const manifest = parseDesktopManifest({ schema: 2, bootstrapProtocol: 2, version, platform: "win32", arch: "x64", sourceRevision, runtimeSource,
    sourceDigest: await desktopSourceDigest(output), files }, version);
  await save(join(output, DESKTOP_MANIFEST), manifest);
  await materializeWindowsRuntime(output, runtimeSource, { orbitVersion: version, managedRoot: resolve(managedUpdateRoot()), downloadAllowed: false, providedArchive: resolve(required(options, "--archive")) });
  await validateDesktopPayload(output, version, manifest.sourceDigest);
  const beforeLauncher = await windowsFileDigest(join(base, DESKTOP_LAUNCHER)), fixtureLauncher = await windowsFileDigest(join(output, DESKTOP_LAUNCHER));
  check(beforeLauncher !== fixtureLauncher, "Real separately compiled fixture host must differ to exercise mapped-host sharing");
  const record = { schema: 1, kind: "owned-offline-fixture", publicRelease: false, feedVerified: false, automaticSelection: false,
    baseVersion: String((await json(join(base, "package.json"))).version), version, baseSourceRevision: sourceRevision,
    sourceDigest: manifest.sourceDigest, omittedPublisherAnnotations: annotation, archiveIntegrity: null,
    maintenanceModuleAudit: await maintenanceModuleAudit(output),
    metadataChanges: ["package.json.version", "GUI assembly informational version", "isolated native host assembly informational version", "desktop-manifest.json", ...(intentionalFailure ? ["src/cli.ts: explicit owned rollback fault"] : [])],
    genuineGui: true, fixtureLauncherDigest: fixtureLauncher, baseLauncherDigest: beforeLauncher, intentionalBrokerFailure: intentionalFailure };
  await save(join(output, "CI-FIXTURE.json"), record); await save(join(evidence, version + "-provenance.json"), record);
  return record;
}

async function stage(payload: string, root: string, baseVersion: string) {
  const marker = await json(join(payload, "CI-FIXTURE.json"));
  check(marker.kind === "owned-offline-fixture" && marker.publicRelease === false && marker.feedVerified === false && marker.baseVersion === baseVersion, "Explicit unpublished staging receipt required");
  const pkg = await json(join(payload, "package.json")), version = String(pkg.version);
  const choices = fixtureVersions(baseVersion, process.env.GITHUB_RUN_ID ?? "");
  check(version === choices.activation || version === choices.rollback, "Unexpected owned fixture version");
  await validateDesktopPayload(payload, version, await desktopSourceDigest(payload)); await regularTree(payload);
  const destination = join(root, "versions", version);
  await withUpdateLock(root, async () => {
    await requireUpdateAdmission(root); check(await missing(destination), "Prepared CI version already exists; no overwrite or deletion");
    await mkdir(destination); await copyExclusiveTree(payload, destination);
    await sealRelease(destination, version, join(destination, DESKTOP_RUNTIME), null);
    await recordWindowsReleaseFiles(destination);
  });
  return version;
}

async function runAcceptance(options: Map<string, string>) {
  const evidence = resolve(required(options, "--evidence")); await mkdir(evidence, { recursive: true });
  const root = resolve(managedUpdateRoot()), initial = await verifyWindowsCurrent(root), stable = join(root, "bin/Orbit.exe");
  const beforeHash = await windowsFileDigest(stable), beforeTask = await registeredTaskXml();
  check(beforeTask, "Actual owned account broker task is missing");
  const candidate = await stage(resolve(required(options, "--candidate")), root, initial.version);
  const rollback = await stage(resolve(required(options, "--rollback")), root, initial.version);
  const result: Record<string, unknown> = { schema: 1, kind: "real-Windows-offline-activation", publicRelease: false, feedVerified: false,
    automaticSelection: false, publicationReadiness: false, runtimeVerified: false, nativeApplicationControl: "unsupported", actualOsGuards: true, initialVersion: initial.version, candidate, rollback };
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    transport = new StdioClientTransport({ command: stable, args: ["--cli", root, "mcp"], stderr: "pipe",
      env: Object.fromEntries(Object.entries({ ...process.env, ORBIT_LAUNCHER: join(root, "bin/sbar-orbit.cmd"), ORBIT_BUN: initial.runtime }).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
    let stderrBytes = 0; transport.stderr?.on("data", data => { stderrBytes += Buffer.byteLength(data); });
    client = new Client({ name: "orbit-owned-windows-ci", version: "1.0.0" });
    await client.connect(transport, { timeout: 30000 }); await client.ping();
    const pid: unknown = Reflect.get(transport, "pid"); check(typeof pid === "number", "Compiled SDK transport PID unavailable");
    const before = await processImage(pid as number);
    check(before?.image.toLowerCase() === stable.toLowerCase(), "Actual MCP transport must be mapped compiled root Orbit.exe, not Bun or a shim");
    const adapterProcesses = await adapterChildren(pid as number, initial.runtime);
    result.mcp = { pid, started: before?.created, image: "bin/Orbit.exe", initialized: true, serverInfo: client.getServerVersion(),
      actualBunChildren: adapterProcesses.map(child => ({ pid: child.pid, started: child.created })) };
    await save(join(evidence, "progress.json"), result);
    const activationHost = join(initial.directory, DESKTOP_LAUNCHER); await assertPE(activationHost);
    const activationCommand = await boundedCommand([activationHost, "--cli", root, "update", "activate", candidate], 120000);
    check(activationCommand.ok, "Real versioned native activation process failed");
    const activation: Record<string, unknown> = JSON.parse(activationCommand.output);
    result.activationRoute = { nativeVersionedHost: true, currentImage: DESKTOP_LAUNCHER, bareBun: false };
    check(activation.activated === true, "Real default activation did not succeed: " + JSON.stringify(activation));
    const selected = await verifyWindowsCurrent(root);
    check(selected.version === candidate && await currentVersion(root) === candidate && selected.runtime === join(root, "versions", candidate, DESKTOP_RUNTIME) && selected.desktopPath === join(root, "versions", candidate, DESKTOP_EXE), "GUI, CLI, runtime and current pointer did not advance coherently");
    const retained = await admittedWindowsBootstrap(root), after = await processImage(pid as number);
    check(retained.version === initial.version && await windowsFileDigest(stable) === beforeHash, "Mapped compatible native host origin was not retained");
    check(after?.created === before?.created && after?.image.toLowerCase() === stable.toLowerCase(), "Original compiled MCP PID/start changed during activation");
    await client.ping();
    const status = await client.callTool({ name: "orbit_status", arguments: {} });
    if (status.isError === true) {
      const payload = status.structuredContent;
      const code = payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string" ? payload.code : undefined;
      check(code === "ORBIT_DISABLED" || code === "CONVERSATION_REQUIRED", "Unexpected standalone MCP status refusal");
      result.mcpStatus = { expectedAuthorizationRefusal: true, code, usageOverride: false, nativeCallsAttempted: 0 };
    } else result.mcpStatus = { actualSessionListReachedNewBroker: true, usageOverride: false, nativeCallsAttempted: 0 };
    check(!(await missing(initial.directory)), "Loaded old source origin was removed");
    const doctor = await call(serviceSocketPath(), "doctor", {}, AbortSignal.timeout(10000)) as { managedIdentity?: { version?: string; root?: string; directory?: string } };
    check(doctor.managedIdentity?.version === candidate && doctor.managedIdentity.root === root && doctor.managedIdentity.directory === selected.directory, "Real new broker identity did not match current prepared version");
    const cliDoctor = await boundedCommand([stable, "--cli", root, "doctor"], 60000); check(cliDoctor.ok, "Compiled stable CLI doctor failed after activation");
    check(JSON.parse(cliDoctor.output).managedIdentity?.version === candidate, "New CLI doctor answered from another broker version");
    result.activation = { ...activation, actualDoctorVersion: doctor.managedIdentity?.version, sameMcpPidAndStart: true, sameInitializedStreamPing: true,
      oldNativeHostRetained: true, oldSourceOriginRetained: true, taskXmlBeforeSha256: hash(beforeTask!), taskXmlAfterSha256: hash((await registeredTaskXml()) ?? "") };
    result.nativeGui = await ownGui(selected.desktopPath, join(evidence, "candidate-gui"), candidate);
    const pruned = await pruneVersions(root, 1);
    check("supported" in pruned && pruned.supported === false && pruned.removed.length === 0 && !(await missing(initial.directory)), "Windows pruning must remain disabled without deleting any old origin");
    result.prune = { supported: false, removed: [], oldSourceStillPresent: true, reason: "reason" in pruned ? pruned.reason : "unavailable" };
    await client.close(); client = undefined;
    const exited = await processImage(pid as number); check(!exited || exited.created !== before?.created, "Owned old compiled MCP host has not exited");
    for (const adapter of adapterProcesses) {
      const current = await processImage(adapter.pid);
      check(!current || current.created !== adapter.created, "Owned Bun MCP child remains after transport close; no lifecycle replacement will begin");
    }
    result.ownedAdapterTreeExited = true;
    result.mcpStderrBytes = stderrBytes;
    const rollbackCommand = await boundedCommand([join(root, "versions", candidate, DESKTOP_LAUNCHER), "--cli", root, "update", "activate", rollback], 120000);
    const failed: Record<string, unknown> = JSON.parse(rollbackCommand.output);
    check(!rollbackCommand.ok, "Failing rollback fixture unexpectedly returned native activation success");
    check(!failed.activated && "rolledBack" in failed && failed.rolledBack === true && failed.rollbackHealthy === true, "Real failing broker did not cause a confirmed healthy rollback");
    const restored = await verifyWindowsCurrent(root), repaired = await admittedWindowsBootstrap(root);
    check(restored.version === candidate && repaired.version === candidate && await windowsFileDigest(stable) === await windowsFileDigest(join(restored.directory, DESKTOP_LAUNCHER)), "After old client exit the admitted native host was not repaired to the current healthy payload");
    const rollbackDoctor = await call(serviceSocketPath(), "doctor", {}, AbortSignal.timeout(10000)) as { managedIdentity?: { version?: string } };
    check(rollbackDoctor.managedIdentity?.version === candidate, "Rollback doctor did not report actual restored broker");
    result.rollback = { ...failed, actualDoctorVersion: candidate, hostRepairVerified: true };
    await save(join(evidence, "before-uninstall.json"), result);
    const registryKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{619AC6C1-90C7-46C8-9C91-9C38D14AE73A}_is1";
    const registryCode = "$ErrorActionPreference='Stop'; $r=Get-ItemProperty -LiteralPath '" + registryKey + "'; @{command=$r.UninstallString;root=$r.InstallLocation}|ConvertTo-Json -Compress";
    const registry = await boundedCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(registryCode, "utf16le").toString("base64")], 10000);
    check(registry.ok, "Owned installer registration missing");
    const registered = JSON.parse(registry.output) as { command: string; root: string };
    check(resolve(registered.root).toLowerCase() === root.toLowerCase() && /^"[^"\r\n]+[.]exe"$/i.test(registered.command), "Owned uninstall registration differs");
    const uninstaller = registered.command.slice(1, -1), installerDirectory = resolve(process.env.LOCALAPPDATA ?? fail("Actual local application directory missing"), "sbar-orbit-installer");
    check(dirname(uninstaller).toLowerCase() === installerDirectory.toLowerCase() && /^unins[0-9]+[.]exe$/i.test(basename(uninstaller)), "Uninstaller is not the installed outside-root component");
    const script = join(installerDirectory, "maintenance.ps1");
    check(hash(await readFile(script)) === hash(await readFile(resolve(import.meta.dir, "../packaging/windows/maintenance.ps1"))), "Installed external maintenance script missing or changed");
    const uninstallerHash = await windowsFileDigest(uninstaller);
    const removed = await boundedCommand([uninstaller, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=" + join(evidence, "uninstall.log")], 120000);
    check(removed.ok, "Actual installed uninstaller/external maintenance did not complete");
    check(await missing(stable) && await missing(join(root, "current.txt")) && await missing(join(root, "versions")), "Owned managed files remain after reported uninstall");
    check(await registeredTaskXml() === null, "Owned broker task remains after uninstall");
    result.uninstall = { actualInstallerUninstaller: true, actualExternalMaintenance: true, uninstallerSha256: uninstallerHash, ownedTasksRemoved: true, currentAbsent: true, versionsAbsent: true, preservedUserData: true };
    result.ok = true; result.runtimeVerified = true; await save(join(evidence, "acceptance.json"), result);
  } catch (error) {
    result.ok = false; result.failure = error instanceof Error ? error.message.slice(0, 1500) : "Owned acceptance failed";
    await save(join(evidence, "acceptance.json"), result); throw error;
  } finally { if (client) await client.close(); else if (transport) await transport.close(); }
}
function required(options: Map<string, string>, key: string) { return options.get(key) ?? fail("Missing " + key); }
if (import.meta.main) {
  hostedWindows(); await requireResourceBudget();
  const [mode, ...argv] = process.argv.slice(2), options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !value || !key.startsWith("--") || options.has(key)) throw new Error("Exact unique option/value pairs required");
    options.set(key, value);
  }
  if (mode === "probe") {
    const report = resolve(required(options, "--report"));
    try { await probe(report); } catch (error) {
      await save(report, { schema: 1, ok: false, platform: process.platform, actualDefaultIpc: false, simulated: false,
        failure: error instanceof Error ? error.message.slice(0, 1000) : "Default IPC evidence not established" });
      throw error;
    }
  }
  else if (mode === "inspect-failure") await inspectFailure(options);
  else if (mode === "prepare") await prepare(options);
  else if (mode === "activate") await runAcceptance(options);
  else fail("Use probe, prepare, activate or inspect-failure only");
}
