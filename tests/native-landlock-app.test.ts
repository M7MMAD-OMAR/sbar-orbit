import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FedoraBackend } from "../src/fedora";

(process.platform === "linux" && process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)(
  "VS Code with disposable settings maps under the socket policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit-vscode-landlock-"));
    const config = join(root, "config");
    const sourceUser = join(config, "Code", "User");
    await mkdir(sourceUser, { recursive: true });
    await writeFile(join(sourceUser, "settings.json"), '{"editor.fontSize":17}');
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    let backend: FedoraBackend | undefined;
    try {
      backend = await FedoraBackend.create();
      const result = await backend.act({ type: "launch-app", app: "vscode", profile: "default", extensions: [] }) as {
        applied: boolean;
        profileSnapshot: { settings: string; accountState: string };
      };
      expect(result.applied).toBe(true);
      expect(result.profileSnapshot).toMatchObject({ settings: "copied", accountState: "absent" });
    } finally {
      await backend?.close();
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
