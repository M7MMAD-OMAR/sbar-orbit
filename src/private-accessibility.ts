import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OrbitError, record } from "./errors";

export function accessibilityEnvironment(directory: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of ["AT_SPI_BUS_ADDRESS", "AT_SPI_REGISTRY", "AT_SPI_DISPLAY", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "NO_AT_BRIDGE", "GTK_A11Y", "QT_ACCESSIBILITY", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON"]) delete env[key];
  return { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, "bus")}`,
    AT_SPI_BUS_ADDRESS: `unix:path=${join(directory, "at-spi/bus")}`, GTK_A11Y: "atspi", QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1" };
}

export async function accessibilityProcess(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
  if (!start || !/^\d+$/.test(start)) throw new OrbitError("UNSUPPORTED", "Accessibility process identity is unavailable");
  return start;
}

export async function inspectAccessibility(directory: string, env: NodeJS.ProcessEnv, pid: number, start: string, title: string) {
  const child = spawn("/usr/bin/python3", [join(import.meta.dir, "native/private_accessibility.py"), "inspect", directory, String(pid), start, title],
    { env: accessibilityEnvironment(directory, env), stdio: ["ignore", "pipe", "pipe"] });
  return accessibilityReply(child);
}

export function accessibilityReply(child: Pick<EventEmitter, "once"> & { stdout: Readable; stderr: Readable; kill(signal: NodeJS.Signals): boolean }) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill("SIGKILL"); }, 6000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262144) { exceeded = true; child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) { reject(new OrbitError("UNSUPPORTED", "Private accessibility inspection is unavailable, ambiguous, or exceeded its bounds")); return; }
      try {
        const value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!Array.isArray(value.nodes) || value.nodes.length > 256 || typeof value.truncated !== "boolean") throw new Error("Invalid accessibility result");
        resolve(value);
      } catch { reject(new OrbitError("BACKEND_FAILED", "Invalid private accessibility response")); }
    });
  });
}
