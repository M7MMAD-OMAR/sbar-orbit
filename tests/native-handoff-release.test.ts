import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { NativeBackend } from "../src/hyprland";
import { NativeWorker } from "../src/native-worker";
import { nativePlugin } from "../src/native-prepare";

test("owner handoff refuses before creating a worker or accessing a host", async () => {
  const worker = spyOn(NativeWorker, "create");
  try {
    await expect(NativeBackend.create("fixture", { planPath: "/unused", controlDirectory: "/unused" },
      { workspace: 4 })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(worker).not.toHaveBeenCalled();
  } finally { worker.mockRestore(); }
});

test.each(["load", "resume"])("owner plugin %s refuses before spawning its owner command", async operation => {
  const spawn = spyOn(Bun, "spawn");
  try {
    await expect(nativePlugin(operation, "/unused")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

(process.platform === "linux" ? test : test.skip)("direct Python owner paths cannot bypass the release hold", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_handoff_release_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(err).toContain("OK");
});
