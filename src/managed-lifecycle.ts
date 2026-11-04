import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, win32, resolve } from "node:path";
import { installedExecutable, serviceUnitDrift, installedPathDefaults } from "./service";
import { BROKER_LABEL, brokerAgentPlist, launchAgentPath, launchAgentsDirectory } from "./macos-autostart";
import { brokerTaskXml, taskActionMatches, currentUserSid, taskNameForUser, TASK_DESCRIPTION } from "./windows-autostart";
import { admitInstalledStartup } from "./installed-startup-diagnostic";
import { realpathSync } from "node:fs";
import { taskPolicyMatches, qualifiedTaskPolicyMatches } from "./windows-task-policy";
import { boundedCommand, type CommandResult, type CommandRunner } from "./lifecycle-command";
export { boundedCommand, type CommandResult, type CommandRunner } from "./lifecycle-command";

import type { BrokerIdentity } from "./managed-identity";
import { selectWindowsBootstrap, verifyWindowsCurrent } from "./windows-bootstrap";

export type ManagedLifecycle = {
  stop?: () => Promise<CommandResult>;
  admit?: (identity: BrokerIdentity) => Promise<CommandResult>;
  restart: () => Promise<CommandResult>;
  schedule: (on: boolean) => Promise<CommandResult>;
};

const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g,
  (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? ""));
const stringAfter = (text: string, key: string) => decode(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1] ?? "");
const value = (text: string, key: string) => decode(new RegExp(`<${key}>([^<]*)</${key}>`).exec(text)?.[1] ?? "");
const refused = (output: string): CommandResult => ({ ok: false, output });
const UPDATE_LABEL = "com.sbar.orbit.update";
const UPDATE_DESCRIPTION = "Sbar Orbit automatic update check";
const agentAbsent = (result: CommandResult) => !result.ok && !result.stopUnconfirmed
  && /Could not find service|Could not find specified service/i.test(result.output);
const unconfirmed = (result: CommandResult): CommandResult => ({ ...result, ok: false, stopUnconfirmed: true });

async function atomic(path: string, contents: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export function updateAgentPlist(launcher: string, socket: string, home = homedir(), bunDirectory = dirname(process.execPath), environment = process.env) {
  return brokerAgentPlist(launcher, socket, home, bunDirectory, environment)
    .replace(`<string>${BROKER_LABEL}</string>`, `<string>${UPDATE_LABEL}</string>`)
    .replace("<string>serve</string>\n    <string>--managed-socket</string>", "<string>update</string>\n    <string>run</string>")
    .replace(/  <key>RunAtLoad<\/key>[\s\S]*?  <key>ProcessType<\/key>/,
      "  <key>StartInterval</key>\n  <integer>86400</integer>\n  <key>ProcessType</key>");
}

function agentEnvironment(contents: string): NodeJS.ProcessEnv {
  const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(contents)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)]
    .map(match => [decode(match[1] ?? ""), decode(match[2] ?? "")]));
}

function loadedAgentOwned(output: string, path: string, launcher: string, contents: string) {
  // launchctl's effective job, rather than a file that may have been replaced
  // since bootstrap. These fields contain complete paths, including spaces.
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(output)?.[1]?.trim();
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents)?.[1] ?? "";
  const expectedArgs = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map(match => decode(match[1] ?? ""));
  const loadedArgs = /^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m.exec(output)?.[1]
    ?.split("\n").map(line => line.trim()).filter(Boolean);
  const block = /^\s*environment = \{\s*\n([\s\S]*?)^\s*\}/m.exec(output)?.[1] ?? "";
  const loadedEnvironment = Object.fromEntries([...block.matchAll(/^\s*(\S+) => (.*)$/gm)]
    .map(match => [match[1] ?? "", match[2]?.trim() ?? ""]));
  const expectedEnvironment = agentEnvironment(contents);
  const relevant = new Set([...Object.keys(expectedEnvironment), ...Object.keys(loadedEnvironment)
    .filter(key => key.startsWith("ORBIT_") || key.startsWith("XDG_") || ["PATH", "HOME", "BUN_INSTALL"].includes(key))]);
  return field("path") === path && field("program") === launcher && field("type") === "LaunchAgent"
    && JSON.stringify(loadedArgs) === JSON.stringify(expectedArgs)
    && [...relevant].every(key => loadedEnvironment[key] === expectedEnvironment[key]);
}

export function updateTaskXml(launcher: string, sid: string, environment: Record<string, string> = {}, recorded = false) {
  // Daily in the interactive account. Missed checks wait for its next login.
  return brokerTaskXml(launcher, sid, environment, recorded)
    .replace(TASK_DESCRIPTION, UPDATE_DESCRIPTION)
    .replace(/    <LogonTrigger>[\s\S]*?<\/LogonTrigger>/,
      `    <CalendarTrigger>\n      <StartBoundary>2020-01-01T04:00:00</StartBoundary>\n      <Enabled>true</Enabled>\n      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>\n      <RandomDelay>PT4H</RandomDelay>\n    </CalendarTrigger>`)
    .replace("<StartWhenAvailable>false</StartWhenAvailable>", "<StartWhenAvailable>true</StartWhenAvailable>")
    .replace(" serve --managed-socket</Arguments>", " update run</Arguments>")
    .replace("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<ExecutionTimeLimit>PT20M</ExecutionTimeLimit>");
}

const NATIVE_UPDATE_DESCRIPTION = UPDATE_DESCRIPTION + " (native schema 2)";
function nativeUpdateAction(launcher: string, runtime: string) {
  const root = win32.dirname(win32.dirname(launcher)), directory = win32.dirname(win32.dirname(runtime));
  if (!win32.isAbsolute(runtime) || runtime !== win32.resolve(runtime) || /["%\r\n\0]/.test(runtime + launcher)
      || launcher !== win32.join(root, "bin/sbar-orbit.cmd") || win32.dirname(directory) !== win32.join(root, "versions")
      || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(win32.basename(directory)) || runtime !== win32.join(directory, "runtime/bun.exe")) throw new Error("Missing exact versioned native updater identity");
  return { command: win32.join(directory, "desktop/windows-app/Orbit.Launcher.exe"), arguments: '--cli "' + root + '" update run' };
}
/** Versioned native pre-TS verification without holding the stable bootstrap image mapped. */
export function windowsDesktopUpdateTaskXml(launcher: string, sid: string, environment: Record<string, string>) {
  if (!environment.ORBIT_BUN) throw new Error("Missing desktop updater runtime");
  const action = nativeUpdateAction(launcher, environment.ORBIT_BUN), contents = updateTaskXml(launcher, sid, environment, true);
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return contents.replace(UPDATE_DESCRIPTION, NATIVE_UPDATE_DESCRIPTION)
    .replace(/<Command>[^<]*<\/Command>/, "<Command>" + escape(action.command) + "</Command>")
    .replace(/<Arguments>[\s\S]*?<\/Arguments>/, "<Arguments>" + escape(action.arguments) + "</Arguments>");
}

export const TASK_OWNERSHIP_UNIQUE_TAGS = ["Description", "LogonType", "RunLevel", "Command", "Arguments", "Settings", "Triggers", "Principals", "MultipleInstancesPolicy", "AllowHardTerminate", "AllowStartOnDemand", "ExecutionTimeLimit", "RunOnlyIfNetworkAvailable", "StartWhenAvailable"] as const;
export const TASK_OWNERSHIP_VALUE_TAGS = ["MultipleInstancesPolicy", "AllowHardTerminate", "Enabled", "AllowStartOnDemand", "ExecutionTimeLimit", "RunOnlyIfNetworkAvailable", "StartWhenAvailable"] as const;
export const TASK_OWNERSHIP_SETTING_TAGS = ["MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "AllowHardTerminate", "StartWhenAvailable", "RunOnlyIfNetworkAvailable", "IdleSettings", "Duration", "WaitTimeout", "StopOnIdleEnd", "RestartOnIdle", "AllowStartOnDemand", "Enabled", "Hidden", "RunOnlyIfIdle", "WakeToRun", "ExecutionTimeLimit", "Priority", "UseUnifiedSchedulingEngine", "DisallowStartOnRemoteAppSession", "Volatile", "RestartOnFailure", "Interval", "Count", "DeleteExpiredTaskAfter", "MaintenanceSettings", "Period", "Deadline", "Exclusive", "Compatibility"] as const;
export const TASK_OWNERSHIP_SHAPE_KEYS = ["present", "single", "selfClosing", "expectedEqual", "valueTrue", "valueFalse", "knownSafeValue"] as const;
export const TASK_OWNERSHIP_CHECK_KEYS = ["argumentEnvelope", "environmentSequence", "environmentKeysKnown", "environmentNoDuplicates", "environmentValuesSafe", "environmentPathsAbsolute", "environmentSchema", "runtimePresent", "runtimePathCanonical", "invocationExact", "diagnosticBundleComplete", "diagnosticAdmissionExact", "diagnosticLauncherScopeExact", "expectedConstructed", "descriptionExact", "principalSidExact", "logonTypeExact", "runLevelExact", "actionCommandExact", "actionArgumentsExact", "actionPairExact", "uniqueFields", "singleExec", "singlePrincipal", "singleActions", "taskRootExact", "actionsContextExact", "actionsExact", "triggersExact", "principalsExact", "settingsExact", "settingsValuesExact", "settingsUnknownTagPresent", ...TASK_OWNERSHIP_UNIQUE_TAGS.map(tag => "unique" + tag), ...TASK_OWNERSHIP_VALUE_TAGS.map(tag => "setting" + tag + "Exact")] as const;
/** Observation only. Never substitute any diagnostic flag for the unchanged taskOwned gate. */
export function taskOwnershipDiagnostics(xml: string, launcher: string, sid: string) {
  const checks: Record<string, boolean> = Object.fromEntries(TASK_OWNERSHIP_CHECK_KEYS.map(key => [key, false]));
  let authoritative = false, authoritativeEvaluated = false;
  try { authoritative = taskOwned(xml, launcher, sid); authoritativeEvaluated = true; } catch { /* Unknown remains non-authoritative. */ }
  const argumentsText = value(xml, "Arguments"); checks.argumentEnvelope = argumentsText.startsWith("/c ");
  let remaining = checks.argumentEnvelope ? argumentsText.slice(3) : "";
  const recorded: Record<string, string> = {}, paths = new Set(["ORBIT_BUN", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ORBIT_SOCKET", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]);
  const diagnosticNames = ["GITHUB_ACTIONS", "ORBIT_TEST_NATIVE", "ORBIT_TEST_INSTALLED_STARTUP_ROOT", "ORBIT_TEST_INSTALLED_STARTUP_BINDING"];
  checks.environmentSequence = checks.environmentKeysKnown = checks.environmentNoDuplicates = checks.environmentValuesSafe = checks.environmentPathsAbsolute = true;
  while (remaining.startsWith('set "')) {
    const match = /^set "([A-Z_][A-Z0-9_]*)=([^"\r\n\0%]*)" && /.exec(remaining);
    if (!match || !match[1] || match[2] === undefined) { checks.environmentSequence = checks.environmentValuesSafe = false; break; }
    const key = match[1], datum = match[2];
    if (recorded[key] !== undefined) checks.environmentNoDuplicates = false;
    if (!paths.has(key) && !diagnosticNames.includes(key) && key !== "ORBIT_MANAGED_ENV_SCHEMA") checks.environmentKeysKnown = false;
    if (paths.has(key) && (!win32.isAbsolute(datum) || !datum)) checks.environmentPathsAbsolute = false;
    recorded[key] = datum; remaining = remaining.slice(match[0].length);
  }
  checks.environmentSchema = recorded.ORBIT_MANAGED_ENV_SCHEMA === "1"; checks.runtimePresent = !!recorded.ORBIT_BUN;
  checks.runtimePathCanonical = !!recorded.ORBIT_BUN && win32.isAbsolute(recorded.ORBIT_BUN) && win32.resolve(recorded.ORBIT_BUN) === recorded.ORBIT_BUN;
  checks.invocationExact = remaining === '"' + launcher + '" serve --managed-socket';
  const diagnosticPresent = diagnosticNames.some(key => recorded[key] !== undefined);
  checks.diagnosticBundleComplete = !diagnosticPresent || !!recorded.ORBIT_TEST_INSTALLED_STARTUP_ROOT && diagnosticNames.every(key => recorded[key] !== undefined);
  checks.diagnosticAdmissionExact = checks.diagnosticLauncherScopeExact = !diagnosticPresent;
  if (diagnosticPresent && checks.diagnosticBundleComplete) {
    const root = recorded.ORBIT_TEST_INSTALLED_STARTUP_ROOT!;
    try { checks.diagnosticAdmissionExact = admitInstalledStartup(recorded, { platform: "win32", runtime: join(root, "package/src/installed-startup-diagnostic.ts") }) === root; } catch {}
    try { checks.diagnosticLauncherScopeExact = realpathSync(launcher).startsWith(realpathSync(join(root, "prefix")) + win32.sep); } catch {}
  }
  let expected = "";
  try { expected = brokerTaskXml(launcher, sid, recorded, true); checks.expectedConstructed = true; } catch {}
  const exact = (tag: string) => checks.expectedConstructed === true && value(xml, tag) === value(expected, tag);
  const users = [...xml.matchAll(/<UserId>([^<]*)<\/UserId>/g)].map(match => decode(match[1] ?? ""));
  checks.descriptionExact = value(xml, "Description") === TASK_DESCRIPTION;
  checks.principalSidExact = users.length > 0 && users.every(user => user === sid);
  checks.logonTypeExact = value(xml, "LogonType") === "InteractiveToken"; checks.runLevelExact = value(xml, "RunLevel") === "LeastPrivilege";
  checks.actionCommandExact = exact("Command"); checks.actionArgumentsExact = exact("Arguments"); checks.actionPairExact = checks.expectedConstructed === true && taskActionMatches(xml, expected);
  for (const tag of TASK_OWNERSHIP_UNIQUE_TAGS) checks["unique" + tag] = (xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>", "g"))?.length ?? 0) === 1;
  checks.uniqueFields = TASK_OWNERSHIP_UNIQUE_TAGS.every(tag => checks["unique" + tag]);
  checks.singleExec = (xml.match(/<Exec>/g)?.length ?? 0) === 1; checks.singlePrincipal = (xml.match(/<Principal\b/g)?.length ?? 0) === 1; checks.singleActions = (xml.match(/<Actions\b/g)?.length ?? 0) === 1;
  checks.taskRootExact = /<Task version="1.4" xmlns="http:\/\/schemas.microsoft.com\/windows\/2004\/02\/mit\/task">/.test(xml);
  checks.actionsContextExact = /<Actions Context="Author">/.test(xml);
  const section = (input: string, name: string) => new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(input)?.[1]?.replace(/>\s+</g, "><").trim();
  const action = (input: string) => /<Actions Context="Author">([\s\S]*?)<\/Actions>/.exec(input)?.[1]?.replace(/>\s+</g, "><").trim();
  checks.actionsExact = checks.expectedConstructed === true && action(xml) === action(expected);
  for (const name of ["Triggers", "Principals", "Settings"]) checks[name.toLowerCase() + "Exact"] = checks.expectedConstructed === true && section(xml, name) === section(expected, name);
  for (const tag of TASK_OWNERSHIP_VALUE_TAGS) checks["setting" + tag + "Exact"] = exact(tag);
  checks.settingsValuesExact = TASK_OWNERSHIP_VALUE_TAGS.every(tag => checks["setting" + tag + "Exact"]);
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(xml)?.[1] ?? "";
  checks.settingsUnknownTagPresent = [...settings.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)\b/g)].some(match => !TASK_OWNERSHIP_SETTING_TAGS.some(tag => tag === match[1]));
  const settingsTagShapes: Record<string, Record<string, boolean>> = {};
  for (const tag of TASK_OWNERSHIP_SETTING_TAGS) {
    const count = (settings.match(new RegExp("<" + tag + "(?:\\s[^>]*)?\\s*/?>", "g"))?.length ?? 0), content = value(settings, tag);
    settingsTagShapes[tag] = { present: count > 0, single: count === 1, selfClosing: new RegExp("<" + tag + "(?:\\s[^>]*)?\\s*/>").test(settings), expectedEqual: exact(tag),
      valueTrue: content === "true", valueFalse: content === "false", knownSafeValue: ["true", "false", "IgnoreNew", "PT0S", "PT20M", "PT72H", "PT10M", "PT1H", "7"].includes(content) };
  }
  return { schema: 1 as const, authoritative, authoritativeEvaluated, checks, settingsTagShapes };
}

export function taskOwned(xml: string, launcher: string, sid: string, updater = false, desktopUpdater = false) {
  const expected = expectedOwnedTask(xml, launcher, sid, updater, desktopUpdater);
  return expected !== null && taskPolicyMatches(xml, expected, sid);
}
/** Shared live qualification for every managed control operation, not a startup bypass. */
export async function taskOwnedLive(xml: string, launcher: string, sid: string, updater = false, desktopUpdater = false) {
  const expected = expectedOwnedTask(xml, launcher, sid, updater, desktopUpdater);
  return expected !== null && await qualifiedTaskPolicyMatches(xml, expected, sid, taskNameForUser(sid) + (updater ? "-Update" : ""));
}

function expectedOwnedTask(xml: string, launcher: string, sid: string, updater = false, desktopUpdater = false) {
  if (desktopUpdater && (!updater || value(xml, "Description") !== NATIVE_UPDATE_DESCRIPTION)) return null;
  if (updater && value(xml, "Description") === NATIVE_UPDATE_DESCRIPTION) {
    const command = value(xml, "Command"), directory = win32.dirname(win32.dirname(win32.dirname(command)));
    const runtime = win32.join(directory, "runtime/bun.exe");
    try {
      const action = nativeUpdateAction(launcher, runtime);
      if (command !== action.command || value(xml, "Arguments") !== action.arguments) return null;
      const expected = windowsDesktopUpdateTaskXml(launcher, sid, { ORBIT_MANAGED_ENV_SCHEMA: "1", ORBIT_BUN: runtime });
      return expected;
    } catch { return null; }
  }
  // Decode a single canonical action. Never inherit values from the updater.
  const argumentsText = value(xml, "Arguments");
  let remaining = argumentsText.startsWith("/c ") ? argumentsText.slice(3) : "";
  const recorded: Record<string, string> = {};
  const paths = new Set(["ORBIT_BUN", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ORBIT_SOCKET", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]);
  const diagnostics = new Set(["GITHUB_ACTIONS", "ORBIT_TEST_NATIVE", "ORBIT_TEST_INSTALLED_STARTUP_ROOT", "ORBIT_TEST_INSTALLED_STARTUP_BINDING"]);
  while (remaining.startsWith('set "')) {
    const match = /^set "([A-Z_][A-Z0-9_]*)=([^"\r\n\0%]*)" && /.exec(remaining);
    if (!match || !match[1] || match[2] === undefined || recorded[match[1]] !== undefined) return null;
    const key = match[1], datum = match[2];
    if (!paths.has(key) && !diagnostics.has(key) && key !== "ORBIT_MANAGED_ENV_SCHEMA") return null;
    if (key === "ORBIT_MANAGED_ENV_SCHEMA" && datum !== "1") return null;
    if (paths.has(key) && (!win32.isAbsolute(datum) || !datum)) return null;
    recorded[key] = datum;
    remaining = remaining.slice(match[0].length);
  }
  if (recorded.ORBIT_MANAGED_ENV_SCHEMA !== "1" || !recorded.ORBIT_BUN
      || (remaining !== `"${launcher}" ${updater ? "update run" : "serve --managed-socket"}`)) return null;
  if ([...diagnostics].some(key => recorded[key] !== undefined)) {
    const root = recorded.ORBIT_TEST_INSTALLED_STARTUP_ROOT;
    if (!root || [...diagnostics].some(key => recorded[key] === undefined)) return null;
    if (admitInstalledStartup(recorded, { platform: "win32", runtime: join(root, "package/src/installed-startup-diagnostic.ts") }) !== root) return null;
    try {
      const prefix = realpathSync(join(root, "prefix"));
      if (!realpathSync(launcher).startsWith(prefix + win32.sep)) return null;
    } catch { return null; }
  }
  const expected = updater ? updateTaskXml(launcher, sid, recorded, true) : brokerTaskXml(launcher, sid, recorded, true);
  return expected;
}

/** Uses only this account's installed mechanism. Tests may supply a command recorder. */
export function managedLifecycle(options: {
  launcher: string; socket: string; platform?: string; home?: string; env?: NodeJS.ProcessEnv;
  run?: CommandRunner; sid?: () => Promise<string>; uid?: number; windowsDesktopRoot?: string;
}): ManagedLifecycle {
  const platform = options.platform ?? process.platform, home = options.home ?? homedir();
  const env = options.env ?? process.env, run = options.run ?? boundedCommand;
  const domain = `gui/${options.uid ?? process.getuid?.()}`;
  const taskSid = options.sid ?? currentUserSid;
  let admittedWindowsArguments: string | undefined;
  const plist = launchAgentPath(home, env);
  const updaterPlist = join(launchAgentsDirectory(home, env), `${UPDATE_LABEL}.plist`);
  const unitDirectory = env.ORBIT_UNIT_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd/user");

  async function stopAgent(label: string): Promise<CommandResult> {
    const stopped = await run(["/bin/launchctl", "bootout", `${domain}/${label}`]);
    if (!stopped.ok) return unconfirmed(stopped);
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = await run(["/bin/launchctl", "print", `${domain}/${label}`], 1_000);
      if (agentAbsent(state)) return { ok: true, output: "" };
      if (!state.ok) return unconfirmed(state);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return unconfirmed(refused("Owned GUI job removal was not confirmed within its deadline"));
  }

  async function bootstrapAgent(path: string, label: string): Promise<CommandResult> {
    const started = await run(["/bin/launchctl", "bootstrap", domain, path]);
    if (started.ok) return started;
    if (started.stopUnconfirmed || started.output.includes("Lifecycle command timed out")) return unconfirmed(started);
    const present = await run(["/bin/launchctl", "print", `${domain}/${label}`], 1_000);
    return agentAbsent(present) ? started : unconfirmed(started);
  }

  async function linuxAdmission(names: string[]) {
    const drift = await serviceUnitDrift(unitDirectory, options.launcher);
    if (!drift.current) return refused("Installed units are missing or drifted; reinstall the managed service");
    for (const name of names) {
      const effective = await run(["systemctl", "--user", "show", name, "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"]);
      if (!effective.ok) return effective;
      const fields = Object.fromEntries(effective.output.split("\n").map(line => {
        const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
      }));
      if (fields.FragmentPath !== join(unitDirectory, name) || fields.DropInPaths !== "" || fields.NeedDaemonReload !== "no")
        return refused("Effective managed units differ from the installed files; inspect overrides and reload deliberately");
    }
    return { ok: true, output: "" };
  }

  async function admit(identity: BrokerIdentity): Promise<CommandResult> {
    let recorded: NodeJS.ProcessEnv;
    let expectedRuntime = identity.runtime;
    let pendingWindowsArguments: string | undefined;
    if (platform === "linux") {
      const admitted = await linuxAdmission(["sbar-orbit.service"]);
      if (!admitted.ok) return admitted;
      recorded = installedPathDefaults(await readFile(join(unitDirectory, "sbar-orbit.service"), "utf8")).defaults;
      const operatorFile = join(recorded.XDG_CONFIG_HOME || join(recorded.HOME || home, ".config"), "sbar-orbit/broker.env");
      const operator = await readFile(operatorFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      const pins = new Set(["ORBIT_BUN", "ORBIT_MANAGED_ENV_SCHEMA", "HOME", "XDG_DATA_HOME", "ORBIT_SOCKET", "PATH"]);
      for (const line of operator.split("\n")) {
        const clean = line.trim();
        if (!clean || clean.startsWith("#") || clean.startsWith(";")) continue;
        const assignment = /^([A-Z_][A-Z0-9_]*)=([^\r\n]*)$/.exec(clean);
        if (!assignment?.[1] || clean.endsWith("\\") || pins.has(assignment[1]))
          return refused("Operator environment identity overrides or ambiguous assignments require deliberate migration");
      }
    } else if (platform === "darwin") {
      const contents = await readFile(plist, "utf8");
      recorded = agentEnvironment(contents);
      const bunDirectory = recorded.PATH?.split(":")[0];
      if (!bunDirectory || contents !== brokerAgentPlist(options.launcher, options.socket, home, bunDirectory, recorded))
        return refused("Installed LaunchAgent differs from its recorded identity");
      const loaded = await run(["/bin/launchctl", "print", `${domain}/${BROKER_LABEL}`]);
      if (!loaded.ok || !loadedAgentOwned(loaded.output, plist, options.launcher, contents))
        return refused("Loaded account job identity is unknown or differs");
    } else if (platform === "win32") {
      const sid = await taskSid();
      const exported = await run(["schtasks.exe", "/Query", "/TN", taskNameForUser(sid), "/XML"]);
      if (!exported.ok || !await taskOwnedLive(exported.output, options.launcher, sid))
        return refused("Installed account task identity is unknown or differs");
      pendingWindowsArguments = value(exported.output, "Arguments");
      recorded = Object.fromEntries([...pendingWindowsArguments.matchAll(/set "([A-Z_][A-Z0-9_]*)=([^"\r\n\0%]*)" && /g)]
        .map(match => [match[1] ?? "", match[2] ?? ""]));
      if (options.windowsDesktopRoot) {
        const selected = await verifyWindowsCurrent(options.windowsDesktopRoot);
        if (selected.root !== identity.root || identity.runtime !== join(identity.directory, "runtime/bun.exe"))
          return refused("Windows candidate is not a coherent desktop and CLI release");
        expectedRuntime = selected.runtime;
      }
    } else return refused("No managed identity admission exists for this platform");
    const recordedRoot = platform === "win32"
      ? win32.join(recorded.LOCALAPPDATA || win32.join(recorded.USERPROFILE || home, "AppData", "Local"), "sbar-orbit", ...(options.windowsDesktopRoot ? ["managed"] : []))
      : join(recorded.XDG_DATA_HOME || join(recorded.HOME || home, ".local/share"), "sbar-orbit");
    if (recorded.ORBIT_MANAGED_ENV_SCHEMA !== "1" || recorded.ORBIT_BUN !== expectedRuntime ||
      resolve(recordedRoot) !== identity.root || (recorded.ORBIT_SOCKET && recorded.ORBIT_SOCKET !== options.socket))
      return refused("Installed mechanism runtime, managed root or socket differs from the prepared release");
    if (pendingWindowsArguments !== undefined) admittedWindowsArguments = pendingWindowsArguments;
    return { ok: true, output: "" };
  }

  async function restart(start = true): Promise<CommandResult> {
    if (platform === "linux") {
      const admission = await linuxAdmission(["sbar-orbit.service"]);
      if (!admission.ok) return admission;
      const unit = await readFile(join(unitDirectory, "sbar-orbit.service"), "utf8").catch(() => "");
      if (!unit.includes("Description=Sbar Orbit local broker") || installedExecutable(unit) !== options.launcher)
        return refused("Installed broker unit ownership or stable launcher differs; reinstall the managed service");
      const restarted = await run(["systemctl", "--user", "restart", "sbar-orbit.service"]);
      return restarted.ok ? restarted : unconfirmed(restarted);
    }
    if (platform === "darwin") {
      const contents = await readFile(plist, "utf8").catch(() => "");
      const recorded = agentEnvironment(contents);
      const bunDirectory = recorded.PATH?.split(":")[0];
      if (!bunDirectory || contents !== brokerAgentPlist(options.launcher, options.socket, home, bunDirectory, recorded))
        return refused("Installed LaunchAgent configuration drifted; reinstall the managed service");
      const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents)?.[1] ?? "";
      const actual = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map(match => decode(match[1] ?? ""));
      if (stringAfter(contents, "Label") !== BROKER_LABEL || JSON.stringify(actual) !== JSON.stringify([options.launcher, "serve", "--managed-socket"]))
        return refused("Installed LaunchAgent ownership or stable launcher differs; reinstall the managed service");
      const present = await run(["/bin/launchctl", "print", `${domain}/${BROKER_LABEL}`]);
      if (present.ok) {
        if (!loadedAgentOwned(present.output, plist, options.launcher, contents))
          return refused("Loaded account GUI job differs from the owned installed LaunchAgent");
        const stopped = await stopAgent(BROKER_LABEL);
        if (!stopped.ok) return stopped;
      } else if (!agentAbsent(present)) return unconfirmed(present);
      return bootstrapAgent(plist, BROKER_LABEL);
    }
    if (platform === "win32") {
      const sid = await taskSid(), task = taskNameForUser(sid);
      const registered = await run(["schtasks.exe", "/Query", "/TN", task, "/XML"]);
      if (!registered.ok || !await taskOwnedLive(registered.output, options.launcher, sid))
        return refused("Installed interactive-logon task ownership or launcher differs; reinstall the managed task");
      if (options.windowsDesktopRoot && (!admittedWindowsArguments || value(registered.output, "Arguments") !== admittedWindowsArguments))
        return unconfirmed(refused("Account task changed after exact installation admission"));
      const stopped = await run(["schtasks.exe", "/End", "/TN", task]);
      if (!stopped.ok) return unconfirmed(stopped);
      // End is a request. Do not start a successor until the scheduler reports exit.
      for (let attempt = 0; attempt < 40; attempt++) {
        const state = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
          `(Get-ScheduledTask -TaskName '${task}' -ErrorAction Stop).State.ToString()`], 1_000);
        if (!state.ok) return unconfirmed(state);
        if (state.output.trim() === "Ready") {
          if (!start) return { ok: true, output: "Owned interactive task exit confirmed" };
          if (options.windowsDesktopRoot) {
            const again = await run(["schtasks.exe", "/Query", "/TN", task, "/XML"]);
            if (!again.ok || !await taskOwnedLive(again.output, options.launcher, sid) || value(again.output, "Arguments") !== admittedWindowsArguments)
              return unconfirmed(refused("Account task changed while stopping"));
            const selected = await selectWindowsBootstrap(options.windowsDesktopRoot);
            const recorded = Object.fromEntries([...value(again.output, "Arguments").matchAll(/set "([A-Z_][A-Z0-9_]*)=([^"\r\n\0%]*)" && /g)].map(match => [match[1]!, match[2]!]));
            const contents = brokerTaskXml(options.launcher, sid, { ...recorded, ORBIT_BUN: selected.runtime }, true);
            const xml = join(options.windowsDesktopRoot, ".broker-task-" + crypto.randomUUID() + ".xml");
            await atomic(xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(contents, "utf16le")]));
            try {
              const changed = await run(["schtasks.exe", "/Create", "/TN", task, "/XML", xml, "/F"]);
              if (!changed.ok) return changed;
              const confirmed = await run(["schtasks.exe", "/Query", "/TN", task, "/XML"]);
              if (!confirmed.ok || !await taskOwnedLive(confirmed.output, options.launcher, sid) || value(confirmed.output, "Arguments") !== value(contents, "Arguments"))
                return unconfirmed(refused("Retargeted account task was not acknowledged"));
              admittedWindowsArguments = value(confirmed.output, "Arguments");
            } finally { await rm(xml, { force: true }); }
            if ((await readFile(join(options.windowsDesktopRoot, "automatic"), "utf8").catch(() => "")).trim() === "on") {
              const updater = await schedule(true); if (!updater.ok) return updater;
            }
          }
          const started = await run(["schtasks.exe", "/Run", "/TN", task]);
          return started.ok ? started : unconfirmed(started);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return unconfirmed(refused("Interactive-logon task did not stop within its deadline"));
    }
    return refused("No managed lifecycle adapter exists for this platform");
  }

  async function schedule(on: boolean): Promise<CommandResult> {
    if (platform === "linux") {
      if (on) {
        const admission = await linuxAdmission(["sbar-orbit-update.timer", "sbar-orbit-update.service"]);
        if (!admission.ok) return admission;
      } else {
        const name = "sbar-orbit-update.timer", path = join(unitDirectory, name);
        const contents = await readFile(path, "utf8").catch(() => "");
        if (!/^Description=Sbar Orbit update check$/m.test(contents) || !/^\[Timer\]$/m.test(contents))
          return refused("Installed update timer ownership is not established; inspect it before disabling");
        const effective = await run(["systemctl", "--user", "show", name, "--property=FragmentPath", "--property=Description", "--property=DropInPaths"]);
        if (!effective.ok) return effective;
        const fields = Object.fromEntries(effective.output.split("\n").map(line => {
          const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
        }));
        if (fields.FragmentPath !== path || fields.Description !== "Sbar Orbit update check" || fields.DropInPaths !== "")
          return refused("Effective update timer ownership is not established; inspect it before disabling");
      }
      return run(["systemctl", "--user", on ? "enable" : "disable", "--now", "sbar-orbit-update.timer"]);
    }
    if (platform === "darwin") {
      const contents = await readFile(updaterPlist, "utf8").catch(() => null);
      const recordedEnvironment = contents ? agentEnvironment(contents) : env;
      const recordedBun = recordedEnvironment.PATH?.split(":")[0];
      const expected = updateAgentPlist(options.launcher, options.socket, home, recordedBun || dirname(process.execPath), recordedEnvironment);
      if (contents !== null && contents !== expected)
        return refused("Update LaunchAgent ownership or configuration differs; inspect it before changing scheduling");
      const present = await run(["/bin/launchctl", "print", `${domain}/${UPDATE_LABEL}`]);
      if (present.ok && contents === null) return refused("Loaded update LaunchAgent has no owned installed file");
      if (present.ok) {
        if (!loadedAgentOwned(present.output, updaterPlist, options.launcher, contents ?? ""))
          return refused("Loaded account GUI update job differs from the owned installed LaunchAgent");
        const stopped = await stopAgent(UPDATE_LABEL);
        if (!stopped.ok) return stopped;
      } else if (!agentAbsent(present)) return unconfirmed(present);
      if (!on) { await rm(updaterPlist, { force: true }); return { ok: true, output: "" }; }
      await atomic(updaterPlist, expected);
      const started = await bootstrapAgent(updaterPlist, UPDATE_LABEL);
      if (!started.ok && !started.stopUnconfirmed) await rm(updaterPlist, { force: true });
      return started;
    }
    if (platform === "win32") {
      const sid = await taskSid(), task = `${taskNameForUser(sid)}-Update`;
      const existing = await run(["schtasks.exe", "/Query", "/TN", task, "/XML"]);
      if (!existing.ok) {
        const enumerated = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
          `@(Get-ScheduledTask -ErrorAction Stop | Where-Object TaskName -eq '${task}').Count`]);
        if (!enumerated.ok || enumerated.output.trim() !== "0") return existing;
      }
      if (existing.ok && !await taskOwnedLive(existing.output, options.launcher, sid, true, !!options.windowsDesktopRoot))
        return refused("Update task ownership or configuration differs; inspect it before changing scheduling");
      if (!on) return existing.ok ? run(["schtasks.exe", "/Delete", "/TN", task, "/F"]) : { ok: true, output: "" };
      const path = join(dirname(options.launcher), `.orbit-update-${crypto.randomUUID()}.xml`);
      try {
        let contents = updateTaskXml(options.launcher, sid);
        if (options.windowsDesktopRoot) {
          const broker = await run(["schtasks.exe", "/Query", "/TN", taskNameForUser(sid), "/XML"]);
          if (!broker.ok || !await taskOwnedLive(broker.output, options.launcher, sid)) return refused("Owned broker task is required for desktop update scheduling");
          const recorded = Object.fromEntries([...value(broker.output, "Arguments").matchAll(/set "([A-Z_][A-Z0-9_]*)=([^"\r\n\0%]*)" && /g)].map(match => [match[1]!, match[2]!]));
          const selected = await verifyWindowsCurrent(options.windowsDesktopRoot, { internalTransition: true });
          if (recorded.ORBIT_BUN !== selected.runtime) return refused("Updater runtime differs from the admitted current release");
          contents = windowsDesktopUpdateTaskXml(options.launcher, sid, recorded);
        }
        await atomic(path, Buffer.from(`\ufeff${contents}`, "utf16le"));
        return await run(["schtasks.exe", "/Create", "/TN", task, "/XML", path, "/F"]);
      } finally { await rm(path, { force: true }); }
    }
    return refused("No managed update scheduler exists for this platform");
  }

  return {
    admit: async identity => { try { return await admit(identity); } catch (error) { return refused(String(error)); } },
    restart: async () => { try { return await restart(); } catch (error) { return refused(String(error)); } },
    stop: async () => { try { return platform === "win32" ? await restart(false) : refused("Explicit owned stop is only implemented for Windows"); } catch (error) { return unconfirmed(refused(String(error))); } },
    schedule: async on => { try { return await schedule(on); } catch (error) { return refused(String(error)); } },
  };
}
