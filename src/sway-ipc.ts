import { createConnection } from "node:net";
import { endianness } from "node:os";
import { OrbitError } from "./errors";

/** One bounded request to an explicitly owned compositor. No socket discovery. */
export function swayRequest(path: string, type: 0 | 4, payload = ""): Promise<any> {
  if (!/^\/tmp\/orbit-native-[^/]+\/sway-ipc\.[^/]+\.sock$/.test(path))
    return Promise.reject(new OrbitError("INVALID_REQUEST", "Private Orbit compositor socket required"));
  const body = Buffer.from(payload);
  const request = Buffer.alloc(14 + body.length);
  request.write("i3-ipc");
  const little = endianness() === "LE";
  if (little) { request.writeUInt32LE(body.length, 6); request.writeUInt32LE(type, 10); }
  else { request.writeUInt32BE(body.length, 6); request.writeUInt32BE(type, 10); }
  body.copy(request, 14);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const fail = () => finish(new OrbitError("BACKEND_FAILED", "Private compositor connection failed"));
    const timer = setTimeout(() => finish(new OrbitError("DEADLINE_EXCEEDED", "Private compositor response timed out")), 5000);
    socket.on("error", fail);
    socket.on("end", fail);
    socket.on("close", fail);
    socket.once("connect", () => socket.write(request));
    socket.on("data", chunk => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 14) return;
      const size = little ? buffer.readUInt32LE(6) : buffer.readUInt32BE(6);
      const replyType = little ? buffer.readUInt32LE(10) : buffer.readUInt32BE(10);
      if (buffer.subarray(0, 6).toString() !== "i3-ipc" || replyType !== type || size > 4 * 1024 * 1024) { fail(); return; }
      if (buffer.length < 14 + size) return;
      try { finish(undefined, JSON.parse(buffer.subarray(14, 14 + size).toString())); }
      catch { fail(); }
    });
  });
}
