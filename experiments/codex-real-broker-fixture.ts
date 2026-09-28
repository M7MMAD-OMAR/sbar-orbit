import { startBroker } from "../src/ipc";

const socketPath = process.argv[2];
const accountRoot = process.argv[3];
if (!socketPath || !accountRoot) throw new Error("socket and account root are required");

const broker = await startBroker({ socketPath, accountRoot });
console.log(JSON.stringify({ ready: true, socket: broker.socket }));

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
