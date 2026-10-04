import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { call } from "./ipc";
import { OrbitError, record } from "./errors";
import { requireResourceBudget } from "./resource-budget";

export type NativePreviewOptions = {
  sessionId: string; appId: string; windowId: string; frames?: number;
  onRendered?: (value: Record<string, unknown>) => void;
};

/** Explicit owner CLI view. One capture waits for its actual GTK draw before the next. */
export async function nativePreview(socket: string, options: NativePreviewOptions,
  entry = ["/usr/bin/python3", join(import.meta.dir, "native/view.py"), "--acknowledgements"]) {
  if (process.platform !== "linux") throw new OrbitError("UNSUPPORTED", "Native GTK viewing requires Linux");
  if (!options.sessionId || !/^[a-f0-9]{32}$/.test(options.appId) || !/^[a-f0-9]{32}$/.test(options.windowId)
      || (options.frames !== undefined && (!Number.isInteger(options.frames) || options.frames < 1 || options.frames > 10000)))
    throw new OrbitError("INVALID_REQUEST", "Use session native-view SESSION APP WINDOW [--frames 1..10000]");
  await requireResourceBudget();
  const controller = new AbortController();
  const observe = async () => {
    const value = record(await call(socket, "session.observe", {
      sessionId: options.sessionId, appId: options.appId, windowId: options.windowId,
    }, controller.signal));
    if (value.appId !== options.appId || value.windowId !== options.windowId || value.mimeType !== "image/png")
      throw new OrbitError("BACKEND_ERROR", "Native preview requires its explicit owned PNG target");
    return value;
  };
  let frame = await observe();
  const child = spawn(entry[0] ?? "/usr/bin/python3", entry.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
  const failures: unknown[] = [];
  let ended = false, rendered = 0, buffer = Buffer.alloc(0);
  let pending: { resolve: (drawn: boolean) => void; reject: (error: Error) => void } | undefined;
  const fail = (error: Error) => {
    failures.push(error); controller.abort(); pending?.reject(error); pending = undefined;
  };
  const exit = new Promise<number | null>(resolve => child.once("close", code => {
    ended = true; controller.abort(); pending?.resolve(false); pending = undefined; resolve(code);
  }));
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 8192) { fail(new OrbitError("BACKEND_ERROR", "Native render acknowledgement exceeds its bound")); return; }
    let newline: number;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      try {
        const value = record(JSON.parse(line.toString("utf8")));
        const point = frame.pointer === null ? null : record(frame.pointer);
        const expected = point === null ? null : [point.x, point.y];
        if (!pending || value.rendered !== true || value.width !== frame.width || value.height !== frame.height
            || JSON.stringify(value.pointer) !== JSON.stringify(expected))
          throw new OrbitError("BACKEND_ERROR", "Native render acknowledgement does not match the supplied target");
        options.onRendered?.(value);
        pending.resolve(true); pending = undefined;
      } catch { fail(new OrbitError("BACKEND_ERROR", "Native renderer returned an invalid acknowledgement")); }
    }
  });
  const stop = () => { controller.abort(); child.stdin.end(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const wait = async (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OrbitError("TIMEOUT", "Native viewer did not close")), ms);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    while (!controller.signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const acknowledgement = new Promise<boolean>((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(() => fail(new OrbitError("TIMEOUT", "Native frame was not drawn before its deadline")), 10_000);
      });
      try {
        child.stdin.write(JSON.stringify(frame) + "\n", error => { if (error) fail(error); });
        if (!await acknowledgement) break;
      } finally { if (timer) clearTimeout(timer); }
      rendered++;
      if (options.frames !== undefined && rendered >= options.frames) break;
      try { await delay(1000, undefined, { signal: controller.signal }); }
      catch (error) { if (!controller.signal.aborted) throw error; }
      if (controller.signal.aborted) break;
      frame = await observe();
    }
  } catch (error) {
    // A normal window exit or explicit signal can abort the outstanding client fetch.
    if (!controller.signal.aborted) failures.push(error);
  } finally {
    controller.abort(); child.stdin.end();
    let code: number | null = null;
    try { code = await wait(5000); }
    catch (error) {
      failures.push(error); child.kill("SIGTERM");
      try { code = await wait(2000); }
      catch (error) {
        failures.push(error); child.kill("SIGKILL");
        try { code = await wait(2000); } catch (error) { failures.push(error); }
      }
    }
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (code !== 0) failures.push(new OrbitError("BACKEND_ERROR", "Native viewer exited unsuccessfully"));
    // A successfully closed window can close its input pipe before the final write callback.
    const actionable = failures.filter(error => !(ended && code === 0 && (error as NodeJS.ErrnoException)?.code === "EPIPE"));
    if (actionable.length) throw new AggregateError(actionable, "Native viewing or cleanup failed");
  }
  return { rendered, closed: ended, captureCadence: "one capture after each draw, at least one second apart" };
}
