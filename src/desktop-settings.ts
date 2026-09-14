/**
 * The desktop settings, for a reader that is not a terminal.
 *
 * Every setting Orbit has is described once, in `desktop/orbit_settings.py`: its default, its range,
 * its validation and the words a person might search for it by. That file already answers as JSON, so
 * this is a bridge rather than a second opinion. Nothing here knows what a setting means; it runs the
 * same program `sbar-orbit config` runs and hands the answer on.
 *
 * The settings file itself stays the source of truth. The panel watches it and reloads, so a change
 * made from the viewer reaches the mark on screen without a restart, and a machine with no viewer
 * open, or no browser at all, keeps every setting it had: nothing here holds state, and nothing here
 * runs unless somebody asks it a question.
 */
import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { OrbitError, record, text } from "./errors";
import { listHostBrowsers } from "./host-browsers";

const script = resolve(import.meta.dir, "../desktop/orbit_settings.py");

export interface DesktopSetting {
  key: string; group: string; label: string; kind: string; description: string;
  value: unknown; default: unknown; choices?: string[]; range?: number[]; storedIn?: string;
}

/**
 * One run of the settings program. The system interpreter, not whatever `python3` resolves to on a
 * developer's path: this file is also read by the panel, which runs under the system one.
 */
async function config(args: string[]) {
  // The environment is passed rather than left to the default, so a caller that points
  // XDG_CONFIG_HOME somewhere else, a test above all, is obeyed by the child that writes the file.
  const child = Bun.spawn(["/usr/bin/python3", script, ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new OrbitError("SETTINGS_REFUSED", error.trim().replace(/^config: /, "") || "The settings program refused the change");
  try { return out.trim() ? JSON.parse(out) : undefined; }
  catch { throw new OrbitError("BACKEND_ERROR", "The settings program answered with something that is not JSON"); }
}

/** Every setting, with the value it currently has. */
export async function listSettings(): Promise<DesktopSetting[]> {
  return await config(["list"]) as DesktopSetting[];
}

/**
 * Change one setting, or put one back the way it was. Values travel as the text the command line takes,
 * because that is where the coercion and the clamping live: a number typed into a box and a number
 * typed into a terminal should be judged by the same code, or one of them is judged by nobody.
 */
export async function writeSetting(params: Record<string, unknown>) {
  // Every setting at once. The schema's own reset does it, so the defaults are not written down here.
  if (params.all === true) await config(["reset"]);
  else {
    const key = text(params.key, "key");
    if (params.reset === true) await config(["reset", key]);
    else {
      if (params.value === undefined) throw new OrbitError("INVALID_REQUEST", "A change needs a value, or reset");
      await config(["set", key, typeof params.value === "string" ? params.value : JSON.stringify(params.value)]);
    }
  }
  // Reading the whole list back is a second run of the program, so a caller that is not about to
  // repaint anything, a slider still under a finger, can say it does not need one.
  return params.list === false ? { settings: [] } : { settings: await listSettings() };
}

/**
 * The monitors this login session has, as the mark on the desktop sees them. Only a client of the
 * compositor can answer that, and a web page is not one, so the panel publishes the list and this
 * reads it. No panel, or no list, means the page asks for a connector name in a plain box rather
 * than pretending to know what is plugged in.
 */
export async function listMonitors(env: Record<string, string | undefined> = process.env) {
  // The same fallback the panel uses when it writes the file, or the two would disagree about where
  // it is on a session that never set the variable.
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}`;
  if (!runtime) return [];
  try {
    const listed = JSON.parse(await readFile(join(runtime, "sbar-orbit", "monitors.json"), "utf8")) as unknown;
    if (!Array.isArray(listed)) return [];
    return listed.filter(entry => entry && typeof entry === "object" && typeof (entry as { connector?: unknown }).connector === "string")
      .map(entry => entry as { connector: string; width?: number; height?: number });
  } catch { return []; }
}

/** The host's own questions about settings, answered off the session dispatcher. */
export async function settingsRequest(body: unknown) {
  const request = record(body);
  // One answer, because the page draws the whole window at once: the settings, the browsers a
  // browser choice can name, and the monitors a placement choice can name.
  if (request.method === "settings.list")
    return { settings: await listSettings(), browsers: await listHostBrowsers(), monitors: await listMonitors() };
  return await writeSetting(request.params === undefined ? {} : record(request.params));
}
