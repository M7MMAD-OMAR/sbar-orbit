import { expect, test } from "bun:test";
import { win32 } from "node:path";
import { captureProcessWitnesses, windowsWitnessApi } from "./windows-process-witness";

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest("retained owned identity survives a confirmed exit before witness capture", async () => {
  const api = await windowsWitnessApi();
  const child = Bun.spawn([process.execPath, "-e",
    'console.log("ready");await new Response(Bun.stdin.stream()).text();process.exit(0);'],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let handle: number | undefined;
  let closed = false;
  let witnesses: ReturnType<typeof captureProcessWitnesses> | undefined;
  try {
    const reader = child.stdout.getReader();
    try {
      let ready = "";
      while (!ready.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw new Error("Disposable child exited before readiness");
        ready += new TextDecoder().decode(next.value);
      }
      expect(ready.trim()).toBe("ready");
    } finally { reader.releaseLock(); }
    handle = api.open(child.pid);
    const retained = handle;
    const before = api.identity(retained);
    expect(before.image).toBe(win32.basename(process.execPath));
    expect(api.state(retained).state).toBe("alive");
    child.stdin.end();
    await child.exited;
    const exited = api.state(retained);
    expect(exited.state).toBe("exited");
    expect(exited.exitTicks).not.toBe("0");
    console.error(JSON.stringify({ witnessRace: "before capture", pid: child.pid, identity: before, state: exited }));
    expect(() => {
      witnesses = captureProcessWitnesses([child.pid], {
        ...api,
        open(pid) { if (pid !== child.pid) throw new Error("Unowned fixture PID"); return retained; },
        close(value) { api.close(value); closed = true; },
      });
    }).not.toThrow();
    if (!witnesses) throw new Error("Retained witness was not captured");
    const measured = witnesses.observe();
    console.error(JSON.stringify({ witnessRace: "after capture", processes: measured }));
    expect(measured).toHaveLength(1);
    expect(measured[0]).toMatchObject({ pid: child.pid, ...before, ...exited });
  } finally {
    try {
      if (child.exitCode === null) child.kill();
      await child.exited;
    } finally {
      if (witnesses) witnesses.close();
      else if (handle !== undefined && !closed) api.close(handle);
    }
  }
}, 10000);
