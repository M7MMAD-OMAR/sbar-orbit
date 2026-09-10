import { startBroker, call } from "./ipc";
import { OrbitError } from "./errors";

const [command, verb, arg, accountName] = process.argv.slice(2);
try {
  if (command === "serve") {
    const broker = await startBroker();
    console.log(JSON.stringify({ socket: broker.socket }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await broker.close();
      process.exit(0);
    };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  } else {
    const socket = process.env.ORBIT_SOCKET;
    if (!socket) throw new OrbitError("CONFIG_REQUIRED", "Set ORBIT_SOCKET to the socket printed by serve");
    let method: string;
    let params: unknown = {};
    if (command === "doctor") method = "doctor";
    else if (command === "preview") method = "preview.open";
    else if (command === "account" && verb === "save") { method = "session.account.save"; params = { sessionId: arg }; }
    else if (command === "session" && ["create", "stop", "pause", "resume", "observe", "list"].includes(verb ?? "")) {
      method = `session.${verb}`;
      params = verb === "create" ? { backend: arg ?? "browser", accountName, agentName: process.env.ORBIT_AGENT_NAME, taskName: process.env.ORBIT_TASK_NAME } : { sessionId: arg };
    } else if (command === "act") {
      method = "session.act";
      params = { sessionId: verb, requestId: process.env.ORBIT_REQUEST_ID ?? crypto.randomUUID(), action: JSON.parse(arg ?? "null") };
    } else throw new OrbitError("INVALID_REQUEST", "Use serve, doctor, preview, session create/list/stop/pause/resume/observe, or act ID JSON");
    console.log(JSON.stringify({ ok: true, result: await call(socket, method, params) }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: error instanceof OrbitError ? error.code : "CLI_ERROR",
    message: error instanceof OrbitError ? error.message : "Command failed" } }));
  process.exitCode = 1;
}
