import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { usableNativeRuntime } from "../src/runtime-paths";

/**
 * l.compositor.smoke from docs/porting.md, run on this host against the runtime a native session
 * uses. The probe is Python so the same file runs inside the Linux family containers, where there
 * is no Bun; this test is what keeps that file honest against the runtime it was written for.
 * The fixtures are the GTK fixture twice, once on Wayland and once through Xwayland.
 */
(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("the bundled compositor passes the smoke probe on this host", async () => {
  const runtime = await usableNativeRuntime(resolve("."));
  expect(runtime.source).not.toBe("none");
  const scratch = await mkdtemp(join(tmpdir(), "orbit-smoke-"));
  try {
    const fixture = (backend: string) => `/usr/bin/env GDK_BACKEND=${backend} /usr/bin/python3 ${resolve("experiments/fedora-display/fixture.py")} ${join(scratch, backend + ".json")}`;
    const probe = Bun.spawn(["/usr/bin/python3", resolve("experiments/linux-families/smoke.py"), "--sway", join(runtime.executables, "sway"), "--libdir", join(runtime.runtime, "root/usr/lib64"),
      "--pointer", runtime.pointer, "--x11", fixture("x11"), "--wayland", fixture("wayland"), "--label", "host"], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text()]);
    expect(await probe.exited).toBe(0);
    const report = JSON.parse(out.trim().split("\n").at(-1)!) as { ok: boolean; steps: Record<string, { ok: boolean } & Record<string, unknown>>; timingsMs: Record<string, number>; error?: string };
    const failed = Object.entries(report.steps).filter(([, step]) => !step.ok).map(([name, step]) => `${name}: ${JSON.stringify(step)}`);
    expect(failed, err).toEqual([]);
    expect(report.ok, report.error).toBe(true);
    // Both fixtures mapped, one through each shell, and a frame came back at the requested size.
    const shells = (report.steps.fixtures!.windows as { shell: string }[]).map(w => w.shell).sort();
    expect(shells).toEqual(["xdg_shell", "xwayland"]);
    expect(report.steps.frame!.decoded).toBe("1280x800");
    expect(report.steps.noLogindContact!.contacts).toEqual([]);
    expect(report.timingsMs.sockets).toBeLessThan(10000);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 60000);
