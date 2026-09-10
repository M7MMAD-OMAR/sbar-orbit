import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { endianness } from "node:os";
import { swayRequest } from "../src/sway-ipc";

test("private compositor transport handles split frames and rejects truncated replies", async () => {
  const path = join(await mkdtemp("/tmp/orbit-native-ipc-test-"), "sway-ipc.test.sock");
  let truncate = false;
  const server = createServer(socket => {
    socket.once("data", async request => {
      if (truncate) { socket.end("i3"); return; }
      const body = Buffer.from(JSON.stringify({ name: "private tree", nodes: [] }));
      const header = Buffer.from(request.subarray(0, 14));
      if (endianness() === "LE") header.writeUInt32LE(body.length, 6);
      else header.writeUInt32BE(body.length, 6);
      socket.write(header.subarray(0, 3));
      await Bun.sleep(5);
      socket.write(header.subarray(3));
      socket.write(body.subarray(0, 4));
      await Bun.sleep(5);
      socket.end(body.subarray(4));
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    expect(await swayRequest(path, 4)).toEqual({ name: "private tree", nodes: [] });
    truncate = true;
    await expect(swayRequest(path, 4)).rejects.toMatchObject({ code: "BACKEND_FAILED" });
    await expect(swayRequest("/run/user/1000/host.sock", 4)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
