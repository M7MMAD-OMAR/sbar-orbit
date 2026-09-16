import { call } from "./ipc";
import { serviceSocketPath } from "./service";
import { connectorEntry } from "./connector-entry";
import { dirname, join } from "node:path";
// Prefer the managed broker's fixed socket, so generated configuration survives a restart.
let socket = process.env.ORBIT_SOCKET, managed = false;
if (!socket) {
  try {
    const path = serviceSocketPath();
    await call(path, "doctor");
    socket = path; managed = true;
  } catch {}
}
if (!socket) { console.error("Start the managed service, or set ORBIT_SOCKET to a running broker socket"); process.exit(1); }
await call(socket, "doctor");
// The launcher this command was reached through, which `bin/sbar-orbit` exports unresolved so an
// installation's stable prefix link is what gets written down rather than the version behind it.
// Running `src/connector-config.ts` directly with Bun sets nothing, and then this source root's own
// launcher is the best name available.
const source = dirname(import.meta.dir);
const invoked = process.env.ORBIT_LAUNCHER;
const fallback = join(source, "bin/sbar-orbit");
const launcher = invoked && await Bun.file(invoked).exists() ? invoked
  : await Bun.file(fallback).exists() ? fallback : undefined;
console.log(JSON.stringify({ mcpServers: { orbit: {
  ...connectorEntry({ launcher, source }),
  env: { ORBIT_SOCKET: socket },
} }, managedSocket: managed }, null, 2));
