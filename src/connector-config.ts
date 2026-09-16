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
const beside = join(source, "bin/sbar-orbit");
const launcher = invoked && await Bun.file(invoked).exists() ? invoked
  : await Bun.file(beside).exists() ? beside : undefined;
// The one host shape that cannot take the launcher: a `.cmd` is not an image the kernel executes, so
// a spawner that does not go through a shell cannot start it. Bun's own spawn resolves it, measured
// on the guest both verbatim and through cmd.exe, and a Node host calling child_process.spawn
// without shell:true does not. `--no-launcher` is that host's answer, and it is a flag rather than a
// guess because nothing here can tell which kind of host is going to read the output.
const windowsFallback = process.argv.includes("--no-launcher");
console.log(JSON.stringify({ mcpServers: { orbit: {
  ...connectorEntry({ launcher, source, windowsFallback }),
  env: { ORBIT_SOCKET: socket },
} }, managedSocket: managed }, null, 2));
