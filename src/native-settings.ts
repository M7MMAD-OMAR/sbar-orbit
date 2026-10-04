import { spawn } from "node:child_process";
import { join } from "node:path";
import { OrbitError } from "./errors";
import { nativeOptionsFromEnv } from "./native-worker";
import { requireResourceBudget } from "./resource-budget";

/** Owner entry only. Agent RPC never launches this UI or chooses its configuration. */
export async function openNativeSettings() {
  if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native controls require Linux and GTK4");
  if (!nativeOptionsFromEnv()) throw new OrbitError("UNSUPPORTED", "Native controls require the owner's configured plan and control directory");
  await requireResourceBudget();
  const child = spawn("/usr/bin/python3", [join(import.meta.dir, "native/settings.py")], { stdio: "inherit" });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new OrbitError("BACKEND_FAILED", "Native controls exited unsuccessfully")));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let stop: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      deadline = setTimeout(() => reject(new OrbitError("TIMEOUT", "Native controls did not exit after termination")), 4000);
    };
  });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await Promise.race([closed, interrupted]); }
  finally {
    if (timer) clearTimeout(timer);
    if (deadline) clearTimeout(deadline);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
