import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
import { copyFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveInstalledApplication } from "../src/application-launch";
import { discoverApplications } from "../src/application-discovery";
const test = linuxOnlySuite("Registered launch fixtures use Linux executables");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-launch-"));
  const home = join(root, "installation home"); const registrations = join(root, "applications");
  const privateHome = join(root, "private home"); const bin = join(home, "random package location");
  for (const directory of [home, registrations, privateHome, bin]) await mkdir(directory, { recursive: true });
  const executable = join(bin, "arbitrary-tool");
  await copyFile("/usr/bin/printenv", executable); await chmod(executable, 0o755);
  const options = { platform: "linux" as const, home, env: { HOME: home, PATH: bin }, applicationDirectories: [registrations], includeRunning: false, recentFile: join(root, "missing") };
  const desktop = (id: string, exec: string, extra = "") => writeFile(join(registrations, id), `[Desktop Entry]\nType=Application\nName=Arbitrary App\nExec=${exec}\n${extra}`);
  return { root, home, privateHome, bin, executable, options, registrations, desktop, close: () => rm(root, { recursive: true, force: true }) };
}

test("registered app at a moved installation preserves argv and working directory", async () => {
  const f = await fixture(); try {
    await f.desktop("org.example.Tool.desktop", `"${f.executable}" "argument with spaces" %F %% %c`, `Path=${f.bin}\n`);
    const result = await resolveInstalledApplication("org.example.Tool.desktop", f.options);
    expect(result).toEqual({ applicationId: "org.example.Tool.desktop", argv: [f.executable, "argument with spaces", "%", "Arbitrary App"], cwd: f.bin });
  } finally { await f.close(); }
});

test("HOME wrapper binds installation location while executed child keeps private HOME", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await writeFile(wrapper, '#!/bin/sh\nexec "$HOME/random package location/arbitrary-tool" "$@"\n', { mode: 0o755 });
    await f.desktop("org.example.Tool.desktop", 'launcher HOME');
    const result = await resolveInstalledApplication("org.example.Tool.desktop", f.options);
    expect(result.argv).toEqual([f.executable, "HOME"]);
    const child = Bun.spawn(result.argv, { env: { HOME: f.privateHome }, stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe(f.privateHome);
    expect(await child.exited).toBe(0);
  } finally { await f.close(); }
});

test("literal wrappers resolve without executing setup scripts", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await writeFile(wrapper, `#!/bin/sh\nexec "${f.executable}" "$@"\n`, { mode: 0o755 });
    await f.desktop("tool.desktop", 'launcher HOME');
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([f.executable, "HOME"]);
    await writeFile(wrapper, `#!/bin/sh\nexport HOME=/other\nexec "${f.executable}" "$@"\n`);
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("supported launch recipe");
  } finally { await f.close(); }
});

test("unquoted wrapper expansions are never reinterpreted as literal executable names", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await f.desktop("tool.desktop", "launcher");
    for (const name of ["tool*", "tool?", "tool[0]", "tool{1,2}"]) {
      const target = join(f.root, name);
      await copyFile(f.executable, target); await chmod(target, 0o755);
      await writeFile(wrapper, `#!/bin/sh\nexec ${target} "$@"\n`, { mode: 0o755 });
      await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("expression");
    }
  } finally { await f.close(); }
});

test("undefined desktop quoting and unquoted reserved arguments refuse", async () => {
  const f = await fixture(); try {
    for (const arg of ['"%i"', 'part"joined"', '"joined"part', '*', '?', '#', '~', '(argument)']) {
      await f.desktop("tool.desktop", `"${f.executable}" ${arg}`, "Icon=example\n");
      await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow();
    }
  } finally { await f.close(); }
});

test("wrapper carriage returns cannot be normalized into a different program", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await f.desktop("tool.desktop", "launcher");
    await writeFile(wrapper, `#!/bin/sh\r\nexec "${f.executable}" "$@"\r\n`, { mode: 0o755 });
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow();
  } finally { await f.close(); }
});

test("multibyte wrapper comments cannot hide statements beyond the read limit", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await f.desktop("tool.desktop", "launcher");
    await writeFile(wrapper, `#!/bin/sh\nexec "${f.executable}" "$@"\n#${"é".repeat(10000)}\nexit 1\n`, { mode: 0o755 });
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("size");
  } finally { await f.close(); }
});

test("an invocation alias does not hide an unsupported shell adapter", async () => {
  const f = await fixture(); try {
    const alias = join(f.bin, "launcher");
    await symlink("/bin/sh", alias);
    await f.desktop("tool.desktop", 'launcher -c "exit 0"');
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("adapter");
  } finally { await f.close(); }
});

test("non-ASCII whitespace inside an Exec argument remains literal", async () => {
  const f = await fixture(); try {
    await f.desktop("tool.desktop", `"${f.executable}" a\u00a0b`);
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([f.executable, "a\u00a0b"]);
  } finally { await f.close(); }
});

test("non-ASCII shell whitespace is not normalized into an exec statement", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await f.desktop("tool.desktop", "launcher");
    await writeFile(wrapper, `#!/bin/sh\n\u00a0exec "${f.executable}" "$@"\n`, { mode: 0o755 });
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow();
  } finally { await f.close(); }
});

test("registration preserves invocation alias instead of changing argv zero", async () => {
  const f = await fixture(); try {
    const alias = join(f.bin, "different-mode");
    await symlink(f.executable, alias);
    await f.desktop("alias.desktop", `"${alias}" HOME`);
    expect((await resolveInstalledApplication("alias.desktop", f.options)).argv[0]).toBe(alias);
  } finally { await f.close(); }
});

test("registered profile overrides do not reuse owner state through launch-installed", async () => {
  const f = await fixture(); try {
    for (const args of ['--profile /owner/profile', '--user-data-dir=/owner/profile', '-P personal', '--profile-directory=Default']) {
      await f.desktop("profile.desktop", `"${f.executable}" ${args}`);
      await expect(resolveInstalledApplication("profile.desktop", f.options)).rejects.toThrow("profile");
    }
  } finally { await f.close(); }
});

test("shared executable registrations retain independently selectable identities", async () => {
  const f = await fixture(); try {
    await f.desktop("one.desktop", `"${f.executable}" ONE`); await f.desktop("two.desktop", `"${f.executable}" TWO`);
    const inventory = await discoverApplications(f.options);
    expect(inventory.applications).toHaveLength(1);
    expect(inventory.applications[0]?.registrationIds).toEqual(["one.desktop", "two.desktop"]);
    expect((await resolveInstalledApplication("two.desktop", f.options)).argv).toEqual([f.executable, "TWO"]);
    await expect(resolveInstalledApplication("missing.desktop", f.options)).rejects.toThrow("No exact");
  } finally { await f.close(); }
});

test("same-root flattened registration ID collision refuses rather than selecting a fallback", async () => {
  const f = await fixture(); try {
    await mkdir(join(f.registrations, "one"));
    await f.desktop("one-two.desktop", `"${f.executable}"`);
    await f.desktop("one/two.desktop", `"${f.executable}"`);
    await expect(resolveInstalledApplication("one-two.desktop", f.options)).rejects.toThrow("ambiguous");
  } finally { await f.close(); }
});

test("D-Bus activatable registrations retain a validated direct Exec compatibility route", async () => {
  const f = await fixture(); try {
    await f.desktop("tool.desktop", `"${f.executable}" %U`, "DBusActivatable=true\n");
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([f.executable]);
    await f.desktop("tool.desktop", `"${f.executable}" $(touch marker)`, "DBusActivatable=true\n");
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("expression");
    await writeFile(join(f.registrations, "tool.desktop"), "[Desktop Entry]\nType=Application\nDBusActivatable=true\n");
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("no Exec");
  } finally { await f.close(); }
});

test("unsafe expressions and unsupported activation adapters refuse before execution", async () => {
  const f = await fixture(); try {
    for (const extra of ["Terminal=true\n", "X-Flatpak=example.App\n"]) {
      await f.desktop("tool.desktop", `"${f.executable}"`, extra);
      await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("unsupported activation");
    }
    await f.desktop("tool.desktop", `"${f.executable}" $(touch marker)`);
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("expression");
    const wrapper = join(f.bin, "launcher");
    await writeFile(wrapper, '#!/bin/sh\nexec "$(touch marker)" "$@"\n', { mode: 0o755 });
    await f.desktop("tool.desktop", 'launcher');
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("expression");
  } finally { await f.close(); }
});

test("disabled user registration takes precedence over system registration", async () => {
  const f = await fixture(); try {
    const system = join(f.root, "system"); await mkdir(system);
    await writeFile(join(system, "tool.desktop"), `[Desktop Entry]\nType=Application\nExec="${f.executable}"\n`);
    await f.desktop("tool.desktop", `"${f.executable}"`, "Hidden=true\n");
    await expect(resolveInstalledApplication("tool.desktop", { ...f.options, applicationDirectories: [f.registrations, system] })).rejects.toThrow("disabled");
  } finally { await f.close(); }
});

test("relative PATH entries cannot silently redirect a registration to a later installation", async () => {
  const f = await fixture(); try {
    await f.desktop("tool.desktop", "arbitrary-tool");
    for (const path of [`.:${f.bin}`, `relative-bin:${f.bin}`, `:${f.bin}`]) {
      await expect(resolveInstalledApplication("tool.desktop", { ...f.options, env: { ...f.options.env, PATH: path } }))
        .rejects.toThrow("relative");
    }
  } finally { await f.close(); }
});

test("desktop string escapes decode before the Exec quoting layer", async () => {
  const f = await fixture(); try {
    const backslashes = "\\".repeat(4);
    await f.desktop("escaping.desktop", `"${f.executable}" "left${backslashes}right" "ordinary argument"`);
    expect((await resolveInstalledApplication("escaping.desktop", f.options)).argv)
      .toEqual([f.executable, "left\\right", "ordinary argument"]);
  } finally { await f.close(); }
});

test("expanded Name and Icon cannot synthesize profile selection arguments", async () => {
  const f = await fixture(); try {
    for (const flag of ["--profile", "--user-data-dir=/owner/profile", "--profile-directory=Default", "-P"]) {
      await writeFile(join(f.registrations, "expanded.desktop"),
        `[Desktop Entry]\nType=Application\nName=${flag}\nExec="${f.executable}" %c /owner/profile\n`);
      await expect(resolveInstalledApplication("expanded.desktop", f.options)).rejects.toThrow("profile");
    }
    await f.desktop("expanded.desktop", `"${f.executable}" %i`, "Icon=--user-data-dir=/owner/profile\n");
    await expect(resolveInstalledApplication("expanded.desktop", f.options)).rejects.toThrow("profile");
  } finally { await f.close(); }
});
