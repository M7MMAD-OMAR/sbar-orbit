import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installService, serviceUnitDrift } from "../src/service";

test.skipIf(process.platform !== "linux" || !Bun.which("systemd-analyze"))(
  "systemd accepts the actual installed launcher path with spaces and specifier characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit service %h $HOME "));
    try {
      const launcher = join(root, "orbit command");
      await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const units = join(root, "units");
      await installService(launcher, units);
      const checked = Bun.spawnSync(["systemd-analyze", "verify",
        join(units, "sbar-orbit.service"), join(units, "sbar-orbit-update.service")],
        { stdout: "pipe", stderr: "pipe" });
      expect({ code: checked.exitCode, errors: checked.stderr.toString() }).toEqual({ code: 0, errors: "" });
      expect((await serviceUnitDrift(units)).current).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
