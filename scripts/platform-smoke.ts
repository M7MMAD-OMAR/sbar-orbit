import { call } from "../src/ipc";
import { join } from "node:path";

/**
 * Starts a private broker from the checkout, asks it for `doctor` over its own endpoint, and stops it.
 * It proves the broker, its socket permissions and its RPC path on this platform. It controls no
 * desktop application and says nothing about native input or capture.
 */
const root = join(import.meta.dir, "..");
const child = Bun.spawn([process.execPath, "run", join(root, "scripts/limited.ts"), process.execPath, "run", join(root, "src/cli.ts"), "serve"], { cwd: root, stdout: "pipe", stderr: "pipe" });
try {
  const reader = child.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 60_000;
  while (!text.includes("\n") && Date.now() < deadline) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  const line = text.split("\n")[0] ?? "";
  if (!line) throw new Error(`broker printed nothing: ${await new Response(child.stderr).text().catch(() => "")}`);
  const { socket } = JSON.parse(line) as { socket: string };
  const doctor = await call(socket, "doctor") as Record<string, unknown>;
  console.log(JSON.stringify({ platform: process.platform, socket, doctor }, null, 2));
  if (doctor.platform !== process.platform) throw new Error("doctor reported another platform");
} finally {
  child.kill();
  await child.exited;
}
