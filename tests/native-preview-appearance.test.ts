import { expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativePreview } from "../src/native-preview";
import { createWorkspaceDirectory } from "../src/workspace-storage";

const enabled = process.platform === "linux" ? test : test.skip;
enabled("native viewer uses fresh filtered settings and removes its configuration after closure", async () => {
  const directory = await createWorkspaceDirectory("preview-appearance");
  const source = join(directory, "source");
  await mkdir(join(source, "gtk-3.0"), { recursive: true, mode: 0o700 });
  const original = "[Settings]\ngtk-application-prefer-dark-theme=true\ngtk-modules=untrusted\n";
  await writeFile(join(source, "gtk-3.0/settings.ini"), original, { mode: 0o600 });
  const saved = process.env.ORBIT_NATIVE_APPEARANCE;
  process.env.ORBIT_NATIVE_APPEARANCE = source;
  const options = { sessionId: "test-session", appId: "a".repeat(32), windowId: "b".repeat(32) };
  const socket = join(directory, "broker.sock");
  const server = Bun.serve({ unix: socket, fetch() {
    return Response.json({ ok: true, result: { ...options, mimeType: "image/png", image: "fixture",
      width: 1, height: 1, pointer: null } });
  } });
  let config = "";
  try {
    await nativePreview(socket, { ...options, frames: 1, onRendered(value) {
      config = String(value.configHome);
      expect(config).not.toBe(source);
      expect(value.settings).toBe("[Settings]\ngtk-application-prefer-dark-theme=true\n");
    } }, ["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor/native_preview_fixture.py"), "appearance"]);
    expect(config).not.toBe("");
    await expect(stat(config)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(source, "gtk-3.0/settings.ini"), "utf8")).toBe(original);
  } finally {
    if (saved === undefined) delete process.env.ORBIT_NATIVE_APPEARANCE; else process.env.ORBIT_NATIVE_APPEARANCE = saved;
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
