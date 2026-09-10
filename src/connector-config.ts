import { call } from "./ipc";
import { join } from "node:path";
const socket = process.env.ORBIT_SOCKET;
if (!socket) { console.error("Set ORBIT_SOCKET to the running broker socket"); process.exit(1); }
await call(socket, "doctor");
console.log(JSON.stringify({ mcpServers: { orbit: {
  command: process.execPath, args: [join(import.meta.dir, "mcp.ts")],
  env: { ORBIT_SOCKET: socket },
} } }, null, 2));
