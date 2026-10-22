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
  const bin = join(home, "random package location");
  for (const directory of [home, registrations, bin]) await mkdir(directory, { recursive: true });
  const executable = join(bin, "arbitrary-tool");
  await copyFile("/usr/bin/printenv", executable); await chmod(executable, 0o755);
  const options = { platform: "linux" as const, home, env: { HOME: home, PATH: bin }, applicationDirectories: [registrations], includeRunning: false, recentFile: join(root, "missing") };
  const desktop = (id: string, exec: string, extra = "") => writeFile(join(registrations, id), `[Desktop Entry]\nType=Application\nName=Arbitrary App\nExec=${exec}\n${extra}`);
  return { root, home, bin, executable, options, registrations, desktop, close: () => rm(root, { recursive: true, force: true }) };
}

test("registered app at a moved installation preserves argv and working directory", async () => {
  const f = await fixture(); try {
    await f.desktop("org.example.Tool.desktop", `"${f.executable}" "argument with spaces" %F %% %c`, `Path=${f.bin}\n`);
    const result = await resolveInstalledApplication("org.example.Tool.desktop", f.options);
    expect(result).toEqual({ applicationId: "org.example.Tool.desktop", argv: [f.executable, "argument with spaces", "%", "Arbitrary App"], cwd: f.bin });
  } finally { await f.close(); }
});

test("HOME wrapper resolves the original installation and preserves owner HOME", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await writeFile(wrapper, '#!/bin/sh\nexec "$HOME/random package location/arbitrary-tool" "$@"\n', { mode: 0o755 });
    await f.desktop("org.example.Tool.desktop", 'launcher HOME');
    const result = await resolveInstalledApplication("org.example.Tool.desktop", f.options);
    expect(result.argv).toEqual([wrapper, "HOME"]);
    const child = Bun.spawn(result.argv, { env: { HOME: f.home }, stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe(f.home);
    expect(await child.exited).toBe(0);
  } finally { await f.close(); }
});

test("literal wrappers resolve without executing setup scripts", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await writeFile(wrapper, `#!/bin/sh\nexec "${f.executable}" "$@"\n`, { mode: 0o755 });
    await f.desktop("tool.desktop", 'launcher HOME');
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([wrapper, "HOME"]);
    await writeFile(wrapper, `#!/bin/sh\nexport HOME=/other\nexec "${f.executable}" "$@"\n`);
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([wrapper, "HOME"]);
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
      expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([wrapper]);
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

test("wrapper carriage returns are left for the original entrypoint instead of normalized", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await f.desktop("tool.desktop", "launcher");
    await writeFile(wrapper, `#!/bin/sh\r\nexec "${f.executable}" "$@"\r\n`, { mode: 0o755 });
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([wrapper]);
  } finally { await f.close(); }
});

test("large installed wrappers remain unchanged instead of being partially interpreted", async () => {
  const f = await fixture(); try {
    const wrapper = join(f.bin, "launcher");
    await f.desktop("tool.desktop", "launcher");
    await writeFile(wrapper, `#!/bin/sh\nexec "${f.executable}" "$@"\n#${"é".repeat(10000)}\nexit 1\n`, { mode: 0o755 });
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([wrapper]);
  } finally { await f.close(); }
});

test("registered interpreter aliases preserve the original invocation without evaluation", async () => {
  const f = await fixture(); try {
    const alias = join(f.bin, "launcher");
    await symlink("/bin/sh", alias);
    await f.desktop("tool.desktop", 'launcher -c "exit 0"');
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([alias, "-c", "exit 0"]);
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
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([wrapper]);
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

test("profile choices in the original registration remain literal arguments", async () => {
  const f = await fixture(); try {
    for (const args of [["--profile", "/owner/profile"], ["--user-data-dir=/owner/profile"], ["-P", "personal"], ["--profile-directory=Default"]]) {
      await f.desktop("profile.desktop", `"${f.executable}" ${args.join(" ")}`);
      expect((await resolveInstalledApplication("profile.desktop", f.options)).argv).toEqual([f.executable, ...args]);
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

test("Flatpak metadata and installed terminal dispatchers retain registered execution semantics", async () => {
  const f = await fixture(); try {
    await f.desktop("tool.desktop", `"${f.executable}"`, "X-Flatpak=example.App\n");
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([f.executable]);
    const terminal = join(f.bin, "xdg-terminal-exec");
    await copyFile(f.executable, terminal); await chmod(terminal, 0o755);
    await f.desktop("tool.desktop", `"${f.executable}" HOME`, "Terminal=true\n");
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([terminal, f.executable, "HOME"]);
    await f.desktop("tool.desktop", `"${f.executable}" $(touch marker)`);
    await expect(resolveInstalledApplication("tool.desktop", f.options)).rejects.toThrow("expression");
    const wrapper = join(f.bin, "launcher");
    await writeFile(wrapper, '#!/bin/sh\nexec "$(touch marker)" "$@"\n', { mode: 0o755 });
    await f.desktop("tool.desktop", 'launcher');
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([wrapper]);
  } finally { await f.close(); }
});

test("terminal-hosted registrations use an installed normal terminal when the desktop dispatcher is absent", async () => {
  const f = await fixture(); try {
    const terminal = join(f.bin, "konsole");
    await copyFile(f.executable, terminal); await chmod(terminal, 0o755);
    await f.desktop("org.kde.konsole.desktop", 'konsole');
    await f.desktop("tool.desktop", `"${f.executable}" HOME`, "Terminal=true\n");
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv).toEqual([terminal, "-e", f.executable, "HOME"]);
  } finally { await f.close(); }
});

for (const terminal of [
  { id: "org.gnome.Ptyxis.desktop", executable: "ptyxis" },
  { id: "org.gnome.Terminal.desktop", executable: "gnome-terminal" },
]) test(`terminal-hosted registrations preserve ${terminal.executable} registered arguments`, async () => {
  const f = await fixture(); try {
    const executable = join(f.bin, terminal.executable);
    await copyFile(f.executable, executable); await chmod(executable, 0o755);
    await f.desktop(terminal.id, `${terminal.executable} --new-window %U`);
    await f.desktop("tool.desktop", `"${f.executable}" "literal payload"`, "Terminal=true\n");
    expect((await resolveInstalledApplication("tool.desktop", f.options)).argv)
      .toEqual([executable, "--new-window", "--", f.executable, "literal payload"]);
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

test("expanded desktop fields remain literal argv entries including profile-looking values", async () => {
  const f = await fixture(); try {
    for (const flag of ["--profile", "--user-data-dir=/owner/profile", "--profile-directory=Default", "-P"]) {
      await writeFile(join(f.registrations, "expanded.desktop"),
        `[Desktop Entry]\nType=Application\nName=${flag}\nExec="${f.executable}" %c /owner/profile\n`);
      expect((await resolveInstalledApplication("expanded.desktop", f.options)).argv).toEqual([f.executable, flag, "/owner/profile"]);
    }
    await f.desktop("expanded.desktop", `"${f.executable}" %i`, "Icon=--user-data-dir=/owner/profile\n");
    expect((await resolveInstalledApplication("expanded.desktop", f.options)).argv).toEqual([f.executable, "--icon", "--user-data-dir=/owner/profile"]);
  } finally { await f.close(); }
});

test("application categories and browser names do not impose launch prohibitions", async () => {
  const f = await fixture(); try {
    for (const category of ["WebBrowser", "TerminalEmulator"]) {
      await f.desktop("org.example.Allowed.desktop", `"${f.executable}"`, `Categories=${category};\n`);
      expect((await resolveInstalledApplication("org.example.Allowed.desktop", f.options)).argv).toEqual([f.executable]);
    }
    await f.desktop("firefox.desktop", `"${f.executable}"`);
    expect((await resolveInstalledApplication("firefox.desktop", f.options)).argv).toEqual([f.executable]);
  } finally { await f.close(); }
});

test.each(["firefox", "zen", "zen-bin", "helium"])("native opening preserves original %s aliases and wrappers", async browserName => {
  const f = await fixture();
  try {
    const browser = join(f.bin, browserName);
    await copyFile("/usr/bin/printenv", browser); await chmod(browser, 0o755);
    for (const mode of ["alias", "wrapper"]) {
      const entry = join(f.bin, "normal-tool-" + mode);
      if (mode === "alias") await symlink(browser, entry);
      else await writeFile(entry, `#!/bin/sh\nexec "${browser}" "$@"\n`, { mode: 0o755 });
      await f.desktop("org.example.Tool.desktop", `"${entry}"`, "Categories=Utility;\n");
      expect((await resolveInstalledApplication("org.example.Tool.desktop", f.options)).argv).toEqual([entry]);
    }
  } finally { await f.close(); }
});

test("registered native Python entry script preserves its installed path without executing during resolution", async () => {
  const f = await fixture(); try {
    await writeFile(f.executable, '#!/usr/bin/python3\nraise RuntimeError("resolution must not run the app")\n', {mode:0o755});
    await f.desktop("native-script.desktop", `"${f.executable}"`);
    expect((await resolveInstalledApplication("native-script.desktop", f.options)).argv).toEqual([f.executable]);
    await writeFile(f.executable, '#!/usr/bin/python3 -c\nprint(1)\n');
    expect((await resolveInstalledApplication("native-script.desktop", f.options)).argv).toEqual([f.executable]);
  } finally { await f.close(); }
});

test("registered environment customization stays unchanged and is not evaluated during resolution", async () => {
  const f = await fixture(); try {
    const options = {...f.options, env:{...f.options.env,PATH:f.bin+":/usr/bin"}};
    for (const assignment of ["GSK_RENDERER=cairo", "MOZ_ENABLE_WAYLAND=1", "QT_IM_MODULE=fcitx", "GSK_RENDERER=cairo=extra"]) {
      await f.desktop("native-env.desktop", `env ${assignment} "${f.executable}"`);
      expect((await resolveInstalledApplication("native-env.desktop",options)).argv).toEqual(["/usr/bin/env",assignment,f.executable]);
    }
    await f.desktop("native-env.desktop", `env GSK_RENDERER=$(touch /tmp/no) "${f.executable}"`);
    await expect(resolveInstalledApplication("native-env.desktop",options)).rejects.toThrow("expression");
    const alias=join(f.bin,"zen");await copyFile(f.executable,alias);await chmod(alias,0o755);
    await f.desktop("native-env.desktop",`env GSK_RENDERER=cairo "${alias}"`);
    expect((await resolveInstalledApplication("native-env.desktop",options)).argv).toEqual(["/usr/bin/env","GSK_RENDERER=cairo",alias]);
  } finally { await f.close(); }
});

test("registered versioned interpreters retain literal arguments without resolution-time execution", async () => {
  const f = await fixture(); try {
    const interpreter=join(f.bin,"python3.14");await copyFile(f.executable,interpreter);await chmod(interpreter,0o755);
    await f.desktop("eval.desktop",`"${interpreter}" -c "raise RuntimeError()"`);
    expect((await resolveInstalledApplication("eval.desktop",f.options)).argv).toEqual([interpreter,"-c","raise RuntimeError()"]);
  } finally {await f.close();}
});


test("native installations beneath browser-like directory names are not browser identities", async () => {
  const f = await fixture(); try {
    for(const directory of ["brave", "operations", "firefox-documents"]) {
      const targetDirectory=join(f.root,directory);await mkdir(targetDirectory);
      const target=join(targetDirectory,"native-tool");await copyFile(f.executable,target);await chmod(target,0o755);
      await f.desktop("org.example.Native.desktop",`"${target}"`,"Categories=Utility;\n");
      expect((await resolveInstalledApplication("org.example.Native.desktop",f.options)).argv).toEqual([target]);
    }
  } finally {await f.close();}
});


test("registered visible GTK and Qt backend customization preserves the normal display environment", async () => {
  const f = await fixture(); try {
    const options = {...f.options,env:{...f.options.env,PATH:f.bin+":/usr/bin"}};
    for(const assignment of ["GDK_BACKEND=x11", "GDK_BACKEND=wayland", "QT_QPA_PLATFORM=xcb"]) {
      await f.desktop("native-display.desktop",`env ${assignment} "${f.executable}"`);
      expect((await resolveInstalledApplication("native-display.desktop",options)).argv).toEqual(["/usr/bin/env",assignment,f.executable]);
    }
    for(const assignment of ["GDK_BACKEND=broadway", "QT_QPA_PLATFORM=offscreen", "DISPLAY=:99", "WAYLAND_DISPLAY=other-session"]) {
      await f.desktop("native-display.desktop",`env ${assignment} "${f.executable}"`);
      expect((await resolveInstalledApplication("native-display.desktop",options)).argv).toEqual(["/usr/bin/env",assignment,f.executable]);
    }
  } finally {await f.close();}
});


test("original browser and terminal registrations retain their installed entrypoint and profile arguments", async () => {
  const f = await fixture(); try {
    for (const category of ["WebBrowser", "TerminalEmulator"]) {
      const entry = join(f.bin, category === "WebBrowser" ? "firefox" : "kgx");
      await copyFile(f.executable, entry); await chmod(entry, 0o755);
      await f.desktop("native-owner.desktop", `"${entry}" --profile-directory=Default`, `Categories=${category};\n`);
      expect((await resolveInstalledApplication("native-owner.desktop", f.options)).argv).toEqual([entry, "--profile-directory=Default"]);
    }
  } finally { await f.close(); }
});

test("registered application setup wrapper is returned unchanged and never evaluated during resolution", async () => {
  const f = await fixture(); try {
    const entry = join(f.bin, "vendor-launcher");
    await writeFile(entry, '#!/bin/sh\nexport VENDOR_SETUP=original\necho do-not-run-during-resolution >&2\nexec /usr/bin/printenv VENDOR_SETUP\n', { mode: 0o755 });
    await f.desktop("vendor.desktop", `"${entry}"`);
    expect((await resolveInstalledApplication("vendor.desktop", f.options)).argv).toEqual([entry]);
  } finally { await f.close(); }
});


test("DBus launch identity comes only from an activatable desktop registration", async () => {
  const f = await fixture();
  try {
    await f.desktop("org.example.Editor.desktop", `"${f.executable}"`, "DBusActivatable=true\n");
    expect(await resolveInstalledApplication("org.example.Editor.desktop", f.options)).toMatchObject({ busName: "org.example.Editor", argv: [f.executable] });
    await f.desktop("org.example.Editor.desktop", `"${f.executable}"`);
    expect(await resolveInstalledApplication("org.example.Editor.desktop", f.options)).not.toHaveProperty("busName");
  } finally { await f.close(); }
});
