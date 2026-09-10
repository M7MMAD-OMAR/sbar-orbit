import { call } from "./ipc";
import { serviceSocketPath } from "./service";
import { join } from "node:path";
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
console.log(JSON.stringify({ mcpServers: { orbit: {
  command: process.execPath, args: [join(import.meta.dir, "mcp.ts")],
  env: { ORBIT_SOCKET: socket },
} }, managedSocket: managed }, null, 2));
