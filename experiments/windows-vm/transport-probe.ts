/**
 * The Windows transport question, answered on a real Windows host rather than from an issue tracker.
 *
 * Orbit's broker serves RPC over `Bun.serve({unix})` on an AF_UNIX socket. Windows has AF_UNIX since
 * 1803, and it has named pipes, and the two differ in the one way that matters here: a pipe can tell
 * the server who connected, and AF_UNIX on Windows cannot, because Microsoft shipped no ancillary
 * data and therefore no peer credentials.
 *
 * Four things are measured, in order of how much they change the design:
 *   1. Does `Bun.serve({unix})` take a pipe name at all, which is Bun issue 15350.
 *   2. Does `Bun.serve({unix})` take a FILESYSTEM path on Windows, which the docs never mention.
 *   3. Does node:net listen on a pipe name and complete a framed request.
 *   4. What DACL does that pipe get by default, read back through a client handle.
 */

import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: Record<string, unknown> = {};
const pipeName = () => `\\\\.\\pipe\\orbit-probe-${crypto.randomUUID().slice(0, 8)}`;

// 1. Bun.serve on a pipe name.
try {
  const server = Bun.serve({ unix: pipeName(), fetch: () => new Response("ok") });
  results.bunServePipeName = "listening";
  server.stop(true);
} catch (error) {
  results.bunServePipeName = `refused: ${(error as Error).message.slice(0, 200)}`;
}

// 2. Bun.serve on a filesystem path, and a real request through it.
const socketRoot = mkdtempSync(join(tmpdir(), "orbit-sock-"));
const socketPath = join(socketRoot, "broker.sock");
try {
  const server = Bun.serve({ unix: socketPath, fetch: () => new Response("pong") });
  try {
    const response = await fetch("http://localhost/rpc", { unix: socketPath, method: "POST", body: "ping" });
    results.bunServeFilesystemUnix = `served: ${await response.text()}`;
  } catch (error) {
    results.bunServeFilesystemUnix = `listened, request failed: ${(error as Error).message.slice(0, 200)}`;
  }
  server.stop(true);
} catch (error) {
  results.bunServeFilesystemUnix = `refused: ${(error as Error).message.slice(0, 200)}`;
}
rmSync(socketRoot, { recursive: true, force: true });

// 3. node:net on a pipe name, with a length prefixed frame, which is what the broker would have to
// speak if Bun.serve cannot take the pipe.
const framed = pipeName();
results.nodeNetPipe = await new Promise<string>(resolve => {
  const server = createServer(socket => {
    socket.on("data", data => {
      const length = data.readUInt32LE(0);
      const body = data.subarray(4, 4 + length).toString();
      const reply = Buffer.from(JSON.stringify({ ok: true, echo: JSON.parse(body) }));
      const out = Buffer.alloc(4 + reply.length);
      out.writeUInt32LE(reply.length, 0);
      reply.copy(out, 4);
      socket.end(out);
    });
  });
  server.on("error", error => resolve(`listen failed: ${error.message}`));
  server.listen(framed, () => {
    const client = connect(framed);
    client.on("error", error => { server.close(); resolve(`connect failed: ${error.message}`); });
    client.on("data", data => {
      const length = data.readUInt32LE(0);
      client.end();
      server.close();
      resolve(`round trip: ${data.subarray(4, 4 + length).toString()}`);
    });
    const payload = Buffer.from(JSON.stringify({ method: "doctor" }));
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    client.write(frame);
  });
  setTimeout(() => { server.close(); resolve("timed out"); }, 10000);
});

// 4. The default DACL on a node:net pipe, read from a client handle, since Get-Acl cannot open a pipe.
const held = pipeName();
results.defaultPipeDacl = await new Promise<string>(resolve => {
  const server = createServer(() => {});
  server.on("error", error => resolve(`listen failed: ${error.message}`));
  server.listen(held, async () => {
    const bare = held.replace("\\\\.\\pipe\\", "");
    const script = `$c=[System.IO.Pipes.NamedPipeClientStream]::new('.','${bare}','InOut');$c.Connect(3000);[System.IO.Pipes.PipesAclExtensions]::GetAccessControl($c).GetSecurityDescriptorSddlForm('All');$c.Dispose()`;
    const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);
    server.close();
    const out = proc.stdout.toString().trim();
    resolve(out || `unreadable: ${proc.stderr.toString().slice(0, 200)}`);
  });
});

results.platform = process.platform;
results.bunVersion = Bun.version;
console.log(JSON.stringify(results, null, 2));
