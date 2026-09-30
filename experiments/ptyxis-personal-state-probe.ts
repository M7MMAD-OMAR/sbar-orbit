/** Read-only personal preferences and normal shell startup on an owned Orbit display. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { FedoraBackend } from "../src/fedora";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const run = promisify(execFile);
const get = async (schema: string, key: string) => (await run("/usr/bin/gsettings", ["get", schema, key], { timeout: 3000 })).stdout.trim();
const profile = (await get("org.gnome.Ptyxis", "default-profile-uuid")).replace(/^'|'$/g, "");
if (!/^[a-zA-Z0-9-]+$/.test(profile)) throw new Error("Unsupported profile identifier");
const profileSchema = `org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/${profile}/`;
if (await get(profileSchema, "use-custom-command") !== "false" || await get(profileSchema, "default-container") !== "'session'")
  throw new Error("Probe requires the current profile to use a local default shell");
const selections = [
  ["org.gnome.Ptyxis", "default-profile-uuid"], ["org.gnome.Ptyxis", "font-name"],
  ["org.gnome.Ptyxis", "use-system-font"], [profileSchema, "login-shell"],
  [profileSchema, "palette"], [profileSchema, "opacity"],
] as const;
const expected = [];
for (const [schema, key] of selections) expected.push(await get(schema, key));
const sourceConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const sources = [join(sourceConfig, "dconf/user"), join(homedir(), ".bashrc"), join(homedir(), ".bash_profile"),
  ...(await readdir(join(homedir(), ".bashrc.d"))).map(name => join(homedir(), ".bashrc.d", name))];
const fingerprint = async () => Promise.all(sources.map(async path => createHash("sha256").update(await readFile(path)).digest("hex")));
const before = await fingerprint();
const history = join(homedir(), ".bash_history");
const historyState = async () => { try { const s = await stat(history); return [s.dev, s.ino, s.size, s.mtimeMs]; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
const historyBefore = await historyState();
const root = await mkdtemp("/tmp/orbit-ptyxis-personal-");
const script = join(root, "read-settings.py"), marker = join(root, "result.json");
await writeFile(marker, "pending\n", { mode: 0o600 });
await writeFile(script, `import json,subprocess,sys\nkeys=${JSON.stringify(selections)}\nvalues=[subprocess.check_output(['/usr/bin/gsettings','get',schema,key],text=True,timeout=3).strip() for schema,key in keys]\nwith open(sys.argv[1],'w') as f: json.dump({'values':values,'startup':[v=='yes' for v in sys.argv[2:]]},f)\n`, { mode: 0o600 });
const emptyPreferences = process.env.ORBIT_PTYXIS_EMPTY_PREFERENCES === "1";
const output = join(process.cwd(), "output", `ptyxis-personal-state${emptyPreferences ? "-empty-control" : ""}-${new Date().toISOString().slice(0, 10)}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = { emptyPreferencesControl: emptyPreferences, settingsCompared: selections.length, settingsMatched: 0, normalShellStartup: false };
const backend = await FedoraBackend.create();
// Experiment-only environment setting. Keep personal shell configuration in place,
// while preventing history reads/writes in the newly launched shell.
const privateEnv = (backend as unknown as { env: NodeJS.ProcessEnv }).env;
privateEnv.HISTFILE = "/dev/null";
try {
  if (emptyPreferences) {
    if (!privateEnv.XDG_CONFIG_HOME?.startsWith("/tmp/orbit-native-")) throw new Error("Owned preference directory required");
    await rm(join(privateEnv.XDG_CONFIG_HOME, "dconf", "user"));
  }
  report.preferenceSnapshot = backend.preferenceSnapshot;
  await backend.act({ type: "launch", toolkit: "wayland", selectedFiles: [script, marker],
    argv: ["/usr/bin/ptyxis", "--standalone", "--new-window", "--working-directory", root] });
  await Bun.sleep(1500);
  // Leading space also matches this user's ignorespace setting. Values and profile
  // identifiers remain in ephemeral files and are never printed or retained.
  const command = ` /usr/bin/python3 '${script}' '${marker}' "$(type __set_title >/dev/null 2>&1 && echo yes)" "$(alias ll >/dev/null 2>&1 && echo yes)" "$([ \"$EDITOR\" = nvim ] && echo yes)" "$([ \"$HISTFILE\" = /dev/null ] && echo yes)"`;
  await backend.act({ type: "text", text: command });
  await backend.act({ type: "key", key: "Enter" });
  const deadline = performance.now() + 15000;
  let result: { values: string[]; startup: boolean[] } | undefined;
  while (performance.now() < deadline) {
    try { result = JSON.parse(await readFile(marker, "utf8")); break; } catch { await Bun.sleep(100); }
  }
  if (!result) throw new Error("Normal terminal shell did not produce a result");
  report.settingsMatched = expected.filter((value, index) => result.values[index] === value).length;
  report.normalShellStartup = result.startup.slice(0, 3).length === 3 && result.startup.slice(0, 3).every(Boolean);
  report.historyDisabled = result.startup[3] === true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await backend.close();
  report.sourcesUnchanged = JSON.stringify(await fingerprint()) === JSON.stringify(before);
  report.historyUnchanged = JSON.stringify(await historyState()) === JSON.stringify(historyBefore);
  await rm(root, { recursive: true });
}
report.passed = report.settingsMatched === selections.length && ["normalShellStartup", "historyDisabled", "sourcesUnchanged", "historyUnchanged"].every(key => report[key] === true);
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
