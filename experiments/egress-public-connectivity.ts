import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as secureConnect, type TLSSocket } from "node:tls";
import { openEgressLease } from "../src/egress";
import { requireResourceBudget } from "../src/resource-budget";

// No account profile, HTTP content, credentials or personal display is used.
// Each check opens the normal bounded CONNECT proxy and verifies a TLS handshake.
if (process.env.ORBIT_PUBLIC_CONNECTIVITY !== "1") throw new Error("Set ORBIT_PUBLIC_CONNECTIVITY=1 for this network diagnostic");
await requireResourceBudget();
const root = await mkdtemp(join(homedir(), ".cache", "orbit-connectivity-"));
const hostname = "nxcloud.masaar.com";
const resolutions: { durationMs: number; answers: number; error?: string }[] = [];
const lease = await openEgressLease({ directory: join(root, "egress"), executable: "/usr/bin/true",
  profile: join(root, "profile"), confinable: true, origins: () => [`https://${hostname}`],
  resolveHost: async name => {
    const started = Date.now();
    try {
      const answers = await lookup(name, { all: true, verbatim: true });
      resolutions.push({ durationMs: Date.now() - started, answers: answers.length });
      return answers.map(answer => answer.address);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      resolutions.push({ durationMs: Date.now() - started, answers: 0,
        error: typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "lookup-failed" });
      throw error;
    }
  },
}).catch(async error => {
  await rm(root, { recursive: true, force: true });
  throw error;
});
const checks: { attempt: number; durationMs: number; proxyStatus?: number; tls?: boolean; error?: string }[] = [];
try {
  if (lease.tier !== "namespace") throw new Error("Namespace lease unavailable");
  for (let attempt = 1; attempt <= 8; attempt++) {
    const started = Date.now();
    const check: typeof checks[number] = { attempt, durationMs: 0 };
    let socket: Socket | undefined;
    let tls: TLSSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      socket = createConnection({ path: join(root, "egress", "lease.sock") });
      timer = setTimeout(() => socket?.destroy(new Error("Connectivity deadline")), 12000);
      await once(socket, "connect");
      const incoming = new Promise<Buffer>((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const data = (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const end = buffer.indexOf("\r\n\r\n");
          if (end >= 0) { socket?.off("data", data); resolve(buffer.subarray(0, end + 4)); }
          else if (buffer.length > 65536) reject(new Error("Oversized proxy header"));
        };
        socket?.on("data", data);
        socket?.once("error", reject);
        socket?.once("end", () => reject(new Error("Proxy ended before header")));
      });
      socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);
      const header = await incoming;
      check.proxyStatus = Number(/^HTTP\/1\.1 ([0-9]{3})/.exec(header.toString())?.[1] ?? 0);
      if (check.proxyStatus === 200) {
        const encrypted = secureConnect({ socket, servername: hostname, rejectUnauthorized: true });
        tls = encrypted;
        await once(encrypted, "secureConnect");
        check.tls = encrypted.authorized;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      check.error = typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "connection-failed";
    } finally {
      if (timer) clearTimeout(timer);
      tls?.destroy(); socket?.destroy();
      check.durationMs = Date.now() - started;
      checks.push(check);
      console.log(JSON.stringify(check));
    }
  }
} finally {
  await lease.close();
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ resolutions, checks: checks.length, successfulTls: checks.filter(check => check.tls).length }));
