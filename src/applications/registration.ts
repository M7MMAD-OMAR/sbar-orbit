import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OrbitError } from "../errors";
import { boundedApplicationEntries, maxApplicationEntries } from "./entries";
import { parseDesktopEntry } from "./desktop-entry";
import type { DiscoveryOptions } from "./types";

const refuse = (message: string): never => { throw new OrbitError("UNSUPPORTED", message); };

export async function findApplicationRegistration(applicationId: string, options: DiscoveryOptions) {
  if ((options.platform ?? process.platform) !== "linux") refuse("Registered application launch has no adapter for this platform");
  if (!/^[^/\\\0\r\n]+\.desktop$/.test(applicationId) || applicationId.length > 1024)
    throw new OrbitError("INVALID_REQUEST", "Choose an exact registered .desktop application ID");
  const env = options.env ?? process.env; const home = options.home ?? env.HOME ?? homedir();
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local/share");
  const roots = options.applicationDirectories ?? [join(data, "applications"),
    join(env.FLATPAK_USER_DIR ?? join(data, "flatpak"), "exports/share/applications"),
    ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(isAbsolute).map(root => join(root, "applications")),
    join(env.FLATPAK_SYSTEM_DIR ?? "/var/lib/flatpak", "exports/share/applications")];
  let remaining = maxApplicationEntries; const deadline = Date.now() + 8000; let registration: string | undefined;
  for (const root of roots) {
    const scan = await boundedApplicationEntries(root, remaining, true, deadline); remaining -= scan.scanned;
    if (scan.truncated || Date.now() >= deadline) refuse("Application registration discovery is incomplete");
    const matches = scan.entries.filter(entry => entry.replaceAll("/", "-") === applicationId);
    if (matches.length > 1) refuse("Application registration identity is ambiguous");
    if (matches[0]) { registration = join(root, matches[0]); break; }
  }
  if (!registration) return refuse("No exact application registration was discovered");
  const metadata = await stat(registration);
  if (!metadata.isFile() || metadata.size > 65536) refuse("Application registration is unavailable or too large");
  const fields = parseDesktopEntry(await readFile(registration, "utf8"));
  return { registration, fields, env, home };
}
