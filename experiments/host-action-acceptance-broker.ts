import { startBroker } from "../src/ipc";

// This fixture owns its socket, state and browser. No managed service is used.
const [socketPath, accountRoot] = process.argv.slice(2);
if (!socketPath || !accountRoot) throw new Error("Private socket and account root are required");
const broker = await startBroker({ socketPath, accountRoot });
let closed = false;
const close = async () => {
  if (closed) return;
  closed = true;
  await broker.close();
  process.exit(0);
};
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
process.stdin.on("end", () => { void close(); });
process.stdin.resume();
