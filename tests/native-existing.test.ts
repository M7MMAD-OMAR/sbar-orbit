import { expect, test } from "bun:test";
import { join } from "node:path";
import { NativeBackend, parseHandoff } from "../src/hyprland";
import { Sessions } from "../src/session";
import { createWorkspaceDirectory } from "../src/workspace-storage";
import { OrbitError } from "../src/errors";

test("existing handoff requires a workspace and paired exact window identity", () => {
  expect(parseHandoff({ workspace: 8 })).toEqual({ workspace: 8 });
  expect(() => parseHandoff({ workspace: 8, address: "0x100" })).toThrow();
  expect(() => parseHandoff({ workspace: 0 })).toThrow();
  expect(() => parseHandoff({ workspace: 8, pid: 123 })).toThrow();
});

test("stop wins while a native resume response is pending", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("handoff-resume-stop"));
  const run = (method: string, params: unknown) => sessions.dispatch({ method, params });
  const created = await run("session.create", { backend: "browser" }) as { sessionId: string };
  const session = sessions["get"](created.sessionId);
  const original = session.backend;
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<void>();
  session.backend = Object.assign(Object.create(NativeBackend.prototype) as NativeBackend, {
    close: () => original.close(), pauseLease: async () => {},
    resumeLease: async () => { started.resolve(); await response.promise; },
  });
  try {
    await run("session.pause", created);
    const resume = run("session.resume", created);
    const outcome = resume.then(value => value, error => error);
    await started.promise;
    await run("session.stop", created);
    response.resolve();
    expect(await outcome).toMatchObject({ code: "SESSION_CLOSED" });
    expect(session.state).toBe("closed");
  } finally { response.resolve(); await sessions.close(); }
});

test("failed native pause blocks admission and can be retried", async () => {
  const sessions = new Sessions(await createWorkspaceDirectory("handoff-pause-retry"));
  const run = (method: string, params: unknown) => sessions.dispatch({ method, params });
  const created = await run("session.create", { backend: "browser" }) as { sessionId: string };
  const session = sessions["get"](created.sessionId);
  const original = session.backend;
  let attempts = 0;
  session.backend = Object.assign(Object.create(NativeBackend.prototype) as NativeBackend, {
    close: () => original.close(), resumeLease: async () => {},
    pauseLease: async () => { if (++attempts === 1) throw new OrbitError("BACKEND_ERROR", "Pause response lost"); },
  });
  try {
    await expect(run("session.pause", created)).rejects.toThrow("Pause response lost");
    expect(session.state).toBe("pausing");
    await expect(run("session.resume", created)).rejects.toMatchObject({ code: "PAUSED" });
    await expect(run("session.pause", created)).resolves.toMatchObject({ state: "paused" });
    expect(attempts).toBe(2);
  } finally { await sessions.close(); }
});

(process.platform === "linux" ? test : test.skip)("borrowed application cleanup preserves live content and recovers a lost claim reply", async () => {
  const entry = join(import.meta.dir, "native_existing_test.py");
  for (const unfixed of [false, true]) {
    const child = Bun.spawn(["/usr/bin/python3", entry, ...(unfixed ? ["--unfixed-close"] : [])], { stdout: "pipe", stderr: "pipe" });
    const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(out).toBe("");
    if (unfixed) { expect(code).toBe(1); expect(errors).toContain("Native session cleanup failed"); }
    else { expect(code).toBe(0); expect(errors).toContain("OK"); }
  }
});
