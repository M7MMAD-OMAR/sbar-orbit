import { startBroker } from "../src/ipc";

const broker = await startBroker();
const dispatch = broker.sessions.dispatch.bind(broker.sessions);
broker.sessions.dispatch = async value => {
  try { return await dispatch(value); }
  catch (error) {
    const details = error as { code?: string; name?: string; message?: string; syscall?: string };
    console.error(JSON.stringify({ code: details.code, name: details.name, message: details.message, syscall: details.syscall }));
    throw error;
  }
};
console.log(JSON.stringify({ socket: broker.socket }));
process.on("SIGTERM", () => { void broker.close().then(() => process.exit(0)); });
