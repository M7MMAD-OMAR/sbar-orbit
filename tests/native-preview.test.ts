import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativePreview } from "../src/native-preview";
import { call } from "../src/ipc";

const enabled = process.platform === "linux" ? test : test.skip;
const fixture = join(import.meta.dir, "../experiments/ghost-cursor/native_preview_fixture.py");
const options = { sessionId: "test-session", appId: "a".repeat(32), windowId: "b".repeat(32) };

for (const mode of ["normal", "close", "malformed"]) enabled(`native preview ${mode} serializes draws and releases its consumer`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-native-preview-"));
  const socket = join(directory, "broker.sock");
  let captures = 0, active = 0, peak = 0, acknowledgements = 0;
  const server = Bun.serve({ unix: socket, async fetch(request) {
    const input = await request.json() as { method: string; params: unknown };
    expect(input).toEqual({ method: "session.observe", params: options });
    captures++; active++; peak = Math.max(peak, active);
    await Bun.sleep(10); active--;
    return Response.json({ ok: true, result: { ...options, mimeType: "image/png", image: "fixture", width: 1, height: 1,
      surfaceWidth: 1, surfaceHeight: 1, pointer: { x: 0, y: 0 }, cursorVariant: 0 } });
  } });
  try {
    const run = nativePreview(socket, { ...options, frames: 3, onRendered: () => acknowledgements++ }, ["/usr/bin/python3", fixture, mode]);
    if (mode === "malformed") await expect(run).rejects.toThrow("Native viewing or cleanup failed");
    else {
      const result = await run;
      expect(result.closed).toBe(true);
      expect(result.rendered).toBe(mode === "close" ? 1 : 3);
      expect(acknowledgements).toBe(result.rendered);
    }
    expect(peak).toBe(1);
    expect(captures).toBe(mode === "normal" ? 3 : 1);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 10_000);

enabled("native IPC client abort does not wait for the server response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-native-abort-"));
  const socket = join(directory, "broker.sock");
  let admitted: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  let finish: (() => void) | undefined;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const server = Bun.serve({ unix: socket, async fetch() { admitted?.(); await held; return Response.json({ ok: true, result: {} }); } });
  try {
    const controller = new AbortController();
    const request = call(socket, "session.observe", options, controller.signal);
    const outcome = request.then(() => { throw new Error("Cancelled native request resolved"); }, error => error);
    await ready; controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
  } finally { finish?.(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
