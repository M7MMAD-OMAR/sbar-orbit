import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, win32, resolve } from "node:path";
import { installedExecutable, serviceUnitDrift, installedPathDefaults } from "./service";
import { BROKER_LABEL, brokerAgentPlist, launchAgentPath, launchAgentsDirectory } from "./macos-autostart";
import { brokerTaskXml, taskActionMatches, currentUserSid, taskNameForUser, TASK_DESCRIPTION } from "./windows-autostart";
import { admitInstalledStartup } from "./installed-startup-diagnostic";
import { realpathSync } from "node:fs";
import { boundedCommand, type CommandResult, type CommandRunner } from "./lifecycle-command";
export { boundedCommand, type CommandResult, type CommandRunner } from "./lifecycle-command";

import type { BrokerIdentity } from "./managed-identity";

export type ManagedLifecycle = {
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

export function taskOwned(xml: string, launcher: string, sid: string, updater = false) {
  // Decode a single canonical action. Never inherit values from the updater.
  const argumentsText = value(xml, "Arguments");
  let remaining = argumentsText.startsWith("/c ") ? argumentsText.slice(3) : "";
  const recorded: Record<string, string> = {};
  const paths = new Set(["ORBIT_BUN", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ORBIT_SOCKET", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]);
  const diagnostics = new Set(["GITHUB_ACTIONS", "ORBIT_TEST_NATIVE", "ORBIT_TEST_INSTALLED_STARTUP_ROOT", "ORBIT_TEST_INSTALLED_STARTUP_BINDING"]);
  while (remaining.startsWith('set "')) {
    const match = /^set "([A-Z_][A-Z0-9_]*)=([^"\r\n\0%]*)" && /.exec(remaining);
    if (!match || !match[1] || match[2] === undefined || recorded[match[1]] !== undefined) return false;
    const key = match[1], datum = match[2];
    if (!paths.has(key) && !diagnostics.has(key) && key !== "ORBIT_MANAGED_ENV_SCHEMA") return false;
    if (key === "ORBIT_MANAGED_ENV_SCHEMA" && datum !== "1") return false;
    if (paths.has(key) && (!win32.isAbsolute(datum) || !datum)) return false;
    recorded[key] = datum;
    remaining = remaining.slice(match[0].length);
  }
  if (recorded.ORBIT_MANAGED_ENV_SCHEMA !== "1" || !recorded.ORBIT_BUN || remaining !== `"${launcher}" ${updater ? "update run" : "serve --managed-socket"}`) return false;
  if ([...diagnostics].some(key => recorded[key] !== undefined)) {
    const root = recorded.ORBIT_TEST_INSTALLED_STARTUP_ROOT;
    if (!root || [...diagnostics].some(key => recorded[key] === undefined)) return false;
    if (admitInstalledStartup(recorded, { platform: "win32", runtime: join(root, "package/src/installed-startup-diagnostic.ts") }) !== root) return false;
    try {
      const prefix = realpathSync(join(root, "prefix"));
      if (!realpathSync(launcher).startsWith(prefix + win32.sep)) return false;
    } catch { return false; }
  }
  const expected = updater ? updateTaskXml(launcher, sid, recorded, true) : brokerTaskXml(launcher, sid, recorded, true);
  const users = [...xml.matchAll(/<UserId>([^<]*)<\/UserId>/g)].map(match => decode(match[1] ?? ""));
  return value(xml, "Description") === (updater ? UPDATE_DESCRIPTION : TASK_DESCRIPTION)
    && users.length > 0 && users.every(user => user === sid)
    && value(xml, "LogonType") === "InteractiveToken" && value(xml, "RunLevel") === "LeastPrivilege"
    && taskActionMatches(xml, expected)
    && ["Description", "LogonType", "RunLevel", "Command", "Arguments", "Settings", "Triggers", "Principals", "MultipleInstancesPolicy", "AllowHardTerminate", "AllowStartOnDemand", "ExecutionTimeLimit", "RunOnlyIfNetworkAvailable", "StartWhenAvailable"].every(key => (xml.match(new RegExp(`<${key}(?:\\s[^>]*)?>`, "g"))?.length ?? 0) === 1)
    && (xml.match(/<Exec>/g)?.length ?? 0) === 1
    && (xml.match(/<Principal\b/g)?.length ?? 0) === 1
    && (xml.match(/<Actions\b/g)?.length ?? 0) === 1
    && /<Task version="1.4" xmlns="http:\/\/schemas.microsoft.com\/windows\/2004\/02\/mit\/task">/.test(xml)
    && /<Actions Context="Author">/.test(xml)
    && /<Actions Context="Author">([\s\S]*?)<\/Actions>/.exec(xml)?.[1]?.replace(/>\s+</g, "><").trim() === /<Actions Context="Author">([\s\S]*?)<\/Actions>/.exec(expected)?.[1]?.replace(/>\s+</g, "><").trim()
    && ["Triggers", "Principals", "Settings"].every(section => {
      const extract = (text: string) => new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(text)?.[1]?.replace(/>\s+</g, "><").trim();
      return extract(xml) === extract(expected);
    })
    && ["MultipleInstancesPolicy", "AllowHardTerminate", "Enabled", "AllowStartOnDemand", "ExecutionTimeLimit", "RunOnlyIfNetworkAvailable", "StartWhenAvailable"]
      .every(key => value(xml, key) === value(expected, key));
}

/** Uses only this account's installed mechanism. Tests may supply a command recorder. */
export function managedLifecycle(options: {
  launcher: string; socket: string; platform?: string; home?: string; env?: NodeJS.ProcessEnv;
  run?: CommandRunner; sid?: () => Promise<string>; uid?: number;
}): ManagedLifecycle {
  const platform = options.platform ?? process.platform, home = options.home ?? homedir();
  const env = options.env ?? process.env, run = options.run ?? boundedCommand;
  const domain = `gui/${options.uid ?? process.getuid?.()}`;
  const taskSid = options.sid ?? currentUserSid;
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
      if (!exported.ok || !taskOwned(exported.output, options.launcher, sid))
        return refused("Installed account task identity is unknown or differs");
      recorded = Object.fromEntries([...value(exported.output, "Arguments").matchAll(/set "([A-Z_][A-Z0-9_]*)=([^"\r\n\0%]*)" && /g)]
        .map(match => [match[1] ?? "", match[2] ?? ""]));
    } else return refused("No managed identity admission exists for this platform");
    const recordedRoot = platform === "win32"
      ? win32.join(recorded.LOCALAPPDATA || win32.join(recorded.USERPROFILE || home, "AppData", "Local"), "sbar-orbit")
      : join(recorded.XDG_DATA_HOME || join(recorded.HOME || home, ".local/share"), "sbar-orbit");
    if (recorded.ORBIT_MANAGED_ENV_SCHEMA !== "1" || recorded.ORBIT_BUN !== identity.runtime ||
      resolve(recordedRoot) !== identity.root || (recorded.ORBIT_SOCKET && recorded.ORBIT_SOCKET !== options.socket))
      return refused("Installed mechanism runtime, managed root or socket differs from the prepared release");
    return { ok: true, output: "" };
  }

  async function restart(): Promise<CommandResult> {
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
      if (!registered.ok || !taskOwned(registered.output, options.launcher, sid))
        return refused("Installed interactive-logon task ownership or launcher differs; reinstall the managed task");
      const stopped = await run(["schtasks.exe", "/End", "/TN", task]);
      if (!stopped.ok) return unconfirmed(stopped);
      // End is a request. Do not start a successor until the scheduler reports exit.
      for (let attempt = 0; attempt < 40; attempt++) {
        const state = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
          `(Get-ScheduledTask -TaskName '${task}' -ErrorAction Stop).State.ToString()`], 1_000);
        if (!state.ok) return unconfirmed(state);
        if (state.output.trim() === "Ready") {
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
      if (existing.ok && !taskOwned(existing.output, options.launcher, sid, true))
        return refused("Update task ownership or configuration differs; inspect it before changing scheduling");
      if (!on) return existing.ok ? run(["schtasks.exe", "/Delete", "/TN", task, "/F"]) : { ok: true, output: "" };
      const path = join(dirname(options.launcher), `.orbit-update-${crypto.randomUUID()}.xml`);
      try {
        await atomic(path, Buffer.from(`\ufeff${updateTaskXml(options.launcher, sid)}`, "utf16le"));
        return await run(["schtasks.exe", "/Create", "/TN", task, "/XML", path, "/F"]);
      } finally { await rm(path, { force: true }); }
    }
    return refused("No managed update scheduler exists for this platform");
  }

  return {
    admit: async identity => { try { return await admit(identity); } catch (error) { return refused(String(error)); } },
    restart: async () => { try { return await restart(); } catch (error) { return refused(String(error)); } },
    schedule: async on => { try { return await schedule(on); } catch (error) { return refused(String(error)); } },
  };
}
