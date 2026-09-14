import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNativeRuntime } from "../src/install";
import { nativeRuntimeLocations, nativeRuntimeName, nativeRuntimePins, sharedRuntimeRoot, usableNativeRuntime } from "../src/runtime-paths";

/**
 * The private display runtime used to live at `<source>/.runtime/sway`, which meant a new version in a
 * new directory started with none of it and native sessions would stop working after an update until
 * somebody rebuilt it. It is shared between versions now, keyed by the packages the bootstrap pins, and
 * a runtime built at the old path is adopted rather than orphaned.
 *
 * Nothing here downloads, compiles or starts a display. Every runtime is a directory with two files in
 * the shape the real one has.
 */
async function fakeRuntime(runtime: string, mark = "sway") {
  await mkdir(join(runtime, "root/usr/bin"), { recursive: true });
  await mkdir(join(runtime, "root/usr/lib64"), { recursive: true });
  await writeFile(join(runtime, "root/usr/bin/sway"), `#!/bin/sh\necho ${mark}\n`);
  await writeFile(join(runtime, "pointer"), mark);
  // The unpacked packages carry relative soname links, and how a copy treats them is the difference
  // between a runtime that stands on its own and one that quietly points back at the tree it came from.
  await writeFile(join(runtime, "root/usr/lib64/libliftoff.so.0.5.0"), mark);
  await symlink("libliftoff.so.0.5.0", join(runtime, "root/usr/lib64/libliftoff.so.0"));
}

/** A temporary data home, so no test reads or writes the person's own shared runtime. */
async function withDataHome<T>(body: (dataHome: string) => Promise<T>) {
  const dataHome = await mkdtemp(join(tmpdir(), "orbit-data-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  try { return await body(dataHome); }
  finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
    await rm(dataHome, { recursive: true, force: true });
  }
}

test("the runtime is named after the packages it was built from, and lives outside every version", async () => {
  await withDataHome(async dataHome => {
    expect(sharedRuntimeRoot()).toBe(join(dataHome, "sbar-orbit/runtime"));
    // Legible first so a person can see what is in the directory, then a digest of the whole set so
    // two pins that differ anywhere at all cannot share one build.
    expect(nativeRuntimeName()).toMatch(/^sway-1\.11-3\.fc44-[0-9a-f]{6}$/);
    expect(nativeRuntimeName(nativeRuntimePins)).not.toBe(nativeRuntimeName([...nativeRuntimePins.slice(0, 2), "libliftoff-0.6.0-1.fc44.x86_64"]));
    const { shared, inSource } = nativeRuntimeLocations("/opt/orbit/versions/9.9.9");
    expect(shared.runtime.startsWith(dataHome)).toBe(true);
    expect(shared.runtime.includes("versions")).toBe(false);
    expect(inSource.runtime).toBe("/opt/orbit/versions/9.9.9/.runtime/sway");
  });
});

test("a session uses the shared runtime, and a runtime built at the old path is still found", async () => {
  await withDataHome(async () => {
    const source = await mkdtemp(join(tmpdir(), "orbit-source-"));
    try {
      const { shared, inSource } = nativeRuntimeLocations(source);
      expect((await usableNativeRuntime(source)).source).toBe("none");
      // What every machine that built one before 14 September 2026 has.
      await fakeRuntime(inSource.runtime, "old");
      const adopted = await usableNativeRuntime(source);
      expect(adopted.source).toBe("in-source");
      expect(adopted.runtime).toBe(inSource.runtime);
      // Once the shared one exists it wins, so a version swap keeps working from one build.
      await fakeRuntime(shared.runtime, "new");
      const preferred = await usableNativeRuntime(source);
      expect(preferred.source).toBe("shared");
      expect(preferred.runtime).toBe(shared.runtime);
    } finally { await rm(source, { recursive: true, force: true }); }
  });
});

test("the install step adopts a runtime built in a source tree rather than downloading again", async () => {
  await withDataHome(async () => {
    const source = await mkdtemp(join(tmpdir(), "orbit-adopt-"));
    try {
      const { shared, inSource } = nativeRuntimeLocations(source);
      await fakeRuntime(inSource.runtime, "adopt-me");
      let bootstrapped = false;
      const outcome = await buildNativeRuntime(source, { which: () => "/usr/bin/tool", bootstrap: async () => { bootstrapped = true; return { ok: true, output: "" }; } });
      expect(bootstrapped).toBe(false);
      expect(outcome).toMatchObject({ state: "done", data: { source: "adopted", runtime: shared.runtime } });
      expect(await readFile(join(shared.runtime, "pointer"), "utf8")).toBe("adopt-me");
      // Measured 14 September 2026: `node:fs/promises` `cp` rewrote this link into an absolute path back
      // into the source tree, so the adopted runtime loaded only while that tree existed, which a version
      // swap ends. The native session gate found it by hiding the source tree, and this keeps it found.
      expect(await readlink(join(shared.runtime, "root/usr/lib64/libliftoff.so.0"))).toBe("libliftoff.so.0.5.0");
      // Adopted once, the step is a no-op and says where the runtime is.
      expect(await buildNativeRuntime(source, { which: () => null })).toMatchObject({ state: "skipped", data: { source: "shared" } });
    } finally { await rm(source, { recursive: true, force: true }); }
  });
});

test("a build with nothing to adopt is pointed at the shared directory, not at the source tree", async () => {
  await withDataHome(async () => {
    const source = await mkdtemp(join(tmpdir(), "orbit-build-"));
    try {
      const { shared } = nativeRuntimeLocations(source);
      const told: string[] = [];
      const outcome = await buildNativeRuntime(source, { which: () => "/usr/bin/tool",
        bootstrap: async (_source, runtimeDirectory) => { told.push(runtimeDirectory); await fakeRuntime(runtimeDirectory, "built"); return { ok: true, output: "sway version 1.11" }; } });
      // The bootstrap reads ORBIT_RUNTIME_DIR, so this is the only thing that decides where a build lands.
      expect(told).toEqual([shared.runtime]);
      expect(outcome).toMatchObject({ state: "done", data: { source: "built", runtime: shared.runtime } });
    } finally { await rm(source, { recursive: true, force: true }); }
  });
});

test("the pinned packages in the bootstrap are the ones the runtime is named after", async () => {
  // Two lists in two languages, and the directory name depends on one of them. This is the check that
  // makes changing the pins in the shell script fail here rather than silently reuse another build.
  const script = await readFile(resolve(import.meta.dir, "../experiments/fedora-display/bootstrap.sh"), "utf8");
  const pinned = [...new Set(script.match(/[a-z0-9]+[a-z0-9.]*-\d[^\s"']*\.x86_64/g) ?? [])];
  expect(pinned.sort()).toEqual([...nativeRuntimePins].sort());
});
