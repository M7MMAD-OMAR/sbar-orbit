import { test as schemaTest, expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
import { mkdir, mkdtemp, rm, symlink, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundedApplicationEntries, discoverApplications, flatpakInfoArguments, parseFlatpakReference, parseAppPaths, selectApplication } from "../src/application-discovery";
const test = linuxOnlySuite("Application discovery filesystem fixtures use Linux executable and proc metadata");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-applications-"));
  const home = join(root, "another account home");
  const bin = join(root, "custom bin");
  const registrations = join(home, "data/applications");
  const proc = join(root, "proc");
  for (const path of [home, bin, registrations, proc]) await mkdir(path, { recursive: true });
  const options = { home, env: { HOME: home, PATH: bin, XDG_DATA_DIRS: "" }, platform: "linux" as const,
    applicationDirectories: [registrations], procRoot: proc };
  const executable = async (name: string) => { const path = join(bin, name); await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); return path; };
  const desktop = async (id: string, exec: string, extra = "") => writeFile(join(registrations, id + ".desktop"),
    `[Desktop Entry]\nType=Application\nName=${id}\nExec=${exec}\n${extra}`);
  return { root, home, bin, registrations, proc, options, executable, desktop, close: () => rm(root, { recursive: true, force: true }) };
}

test("discovers arbitrary registered apps at moved paths with spaces, without starting them", async () => {
  const f = await fixture(); try {
    const executable = await f.executable("painting-tool");
    await f.desktop("painting", `"${executable}" %F`);
    const report = await discoverApplications(f.options);
    expect(report.applications.map(app => app.executable)).toEqual([executable]);
    expect(report.applications[0]?.sources[0]).toContain("desktop:");
    expect(report.applications[0]?.channel).toBe("not measured");
  } finally { await f.close(); }
});

test("stale registrations and hidden user overrides do not report installed applications", async () => {
  const f = await fixture(); try {
    const executable = await f.executable("painting-tool");
    const system = join(f.root, "system applications"); await mkdir(system);
    await f.desktop("painting", `"${executable}"`, "Hidden=true\n");
    await writeFile(join(system, "painting.desktop"), `[Desktop Entry]\nType=Application\nExec="${executable}"\n`);
    await f.desktop("missing", '"/missing/app"');
    expect((await discoverApplications({ ...f.options, applicationDirectories: [f.registrations, system] })).applications).toEqual([]);
  } finally { await f.close(); }
});

test("PATH symlinks and literal wrappers resolve to the installed executable", async () => {
  const f = await fixture(); try {
    const archive = join(f.root, "portable archive"); await mkdir(archive);
    const executable = join(archive, "zen"); await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(f.bin, "zen"), `#!/bin/sh\nexec "${executable}" "$@"\n`, { mode: 0o755 });
    await symlink(executable, join(f.bin, "zen-browser"));
    const apps = (await discoverApplications(f.options)).applications;
    expect(apps).toHaveLength(1); expect(apps[0]?.executable).toBe(executable);
  } finally { await f.close(); }
});

test("running installation takes priority over another installed version and retains only profile metadata", async () => {
  const f = await fixture(); try {
    const older = await f.executable("zen"); await f.desktop("older", `"${older}"`);
    const newerDirectory = join(f.root, "active nightly"); await mkdir(newerDirectory);
    const newer = join(newerDirectory, "zen"); await writeFile(newer, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const pid = join(f.proc, "123"); await mkdir(pid); await symlink(newer, join(pid, "exe"));
    const profile = join(f.home, "custom profile"); await mkdir(profile);
    await writeFile(join(pid, "cmdline"), [newer, "--profile", profile, "https://private.invalid/secret"].join("\0"));
    const apps = (await discoverApplications(f.options)).applications;
    const selected = selectApplication(apps, "zen");
    expect(selected.executable).toBe(newer); expect(selected.profileDirectories).toEqual([profile]);
    expect(JSON.stringify(apps)).not.toContain("private.invalid");
  } finally { await f.close(); }
});

test("two running versions refuse implicit selection and deleted executables are ignored", async () => {
  const f = await fixture(); try {
    for (const n of [1, 2]) {
      const dir = join(f.root, `installation-${n}`); await mkdir(dir);
      const executable = join(dir, "zen"); await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const pid = join(f.proc, String(n)); await mkdir(pid); await symlink(executable, join(pid, "exe"));
    }
    const report = await discoverApplications(f.options);
    expect(() => selectApplication(report.applications, "zen")).toThrow("ambiguous");
    await mkdir(join(f.proc, "3"));
    await symlink("/missing/zen (deleted)", join(f.proc, "3/exe"));
    expect((await discoverApplications(f.options)).applications).toHaveLength(2);
  } finally { await f.close(); }
});

test("query narrows the report and unavailable proc metadata does not claim active state", async () => {
  const f = await fixture(); try {
    await f.executable("zen"); const painter = await f.executable("painting"); await f.desktop("painting", painter);
    const report = await discoverApplications({ ...f.options, query: "zen", procRoot: join(f.root, "missing") });
    expect(report.applications).toHaveLength(1); expect(report.applications[0]?.runningPids).toEqual([]);
    expect(report.notes.join(" ")).toContain("unavailable");
  } finally { await f.close(); }
});

test("relative PATH entries are ignored and shell substitutions are never evaluated", async () => {
  const f = await fixture(); try {
    await f.executable("zen");
    await f.desktop("unsafe", '"$(touch /tmp/orbit-unwanted)"');
    const report = await discoverApplications({ ...f.options, env: { PATH: ".", HOME: f.home } });
    expect(report.applications).toEqual([]);
  } finally { await f.close(); }
});

test("a desktop registration cannot execute an arbitrary binary named flatpak during discovery", async () => {
  const f = await fixture(); try {
    const marker = join(f.root, "executed");
    const executable = join(f.bin, "flatpak");
    await writeFile(executable, `#!/bin/sh\ntouch "${marker}"\necho /fake/deployment\n`, { mode: 0o755 });
    await f.desktop("fake-flatpak", `"${executable}" run app.example.Tool`);
    await discoverApplications(f.options);
    expect(await access(marker).then(() => true, () => false)).toBe(false);
  } finally { await f.close(); }
});

test("macOS bundles use executable metadata instead of a fixed product list", async () => {
  const f = await fixture(); try {
    const bundle = join(f.root, "apps/Unknown Drawing.app/Contents"); await mkdir(join(bundle, "MacOS"), { recursive: true });
    const executable = join(bundle, "MacOS/drawing"); await writeFile(executable, "fixture", { mode: 0o755 });
    await writeFile(join(bundle, "Info.plist"), '<plist><dict><key>CFBundleExecutable</key><string>drawing</string><key>CFBundleIdentifier</key><string>example.drawing</string></dict></plist>');
    const report = await discoverApplications({ ...f.options, platform: "darwin", bundleRoots: [join(f.root, "apps")] });
    expect(report.applications[0]?.executable).toBe(executable); expect(report.applications[0]?.id).toBe("example.drawing");
    expect(report.notes.join(" ")).toContain("not measured");
  } finally { await f.close(); }
});

test("macOS bundle executable traversal is refused", async () => {
  const f = await fixture(); try {
    const bundle = join(f.root, "apps/Bad.app/Contents"); await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "Info.plist"), '<key>CFBundleExecutable</key><string>../../outside</string>');
    expect((await discoverApplications({ ...f.options, platform: "darwin", bundleRoots: [join(f.root, "apps")] })).applications).toEqual([]);
  } finally { await f.close(); }
});

test("Windows App Paths preserves current-user precedence and verifies executable presence", async () => {
  const f = await fixture(); try {
    const user = await f.executable("tool.exe"); const system = await f.executable("other.exe");
    const report = await discoverApplications({ ...f.options, platform: "win32", registryEntries: [
      { id: "tool.exe", executable: user }, { id: "TOOL.EXE", executable: system }, { id: "absent.exe", executable: "/missing" },
    ] });
    expect(report.applications.map(app => app.executable)).toEqual([user]);
    expect(report.applications[0]?.profileDirectories).toEqual([]);
  } finally { await f.close(); }
});

schemaTest("App Paths parser expands explicit environment values without choosing registry Path as executable", () => {
  expect(parseAppPaths('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\paint.exe\n    (Default)    REG_EXPAND_SZ    "%LOCALAPPDATA%\\Tools\\paint.exe"\n    Path    REG_SZ    C:\\libs\n', { LOCALAPPDATA: "D:\\User Data" }))
    .toEqual([{ id: "paint.exe", executable: "D:\\User Data\\Tools\\paint.exe" }]);
});

schemaTest("Flatpak metadata verification preserves the exact branch, architecture and installation", () => {
  const reference = parseFlatpakReference(["flatpak", "run", "--branch=beta", "--arch", "x86_64", "--user", "--command=launch-script.sh", "--file-forwarding", "app.zen_browser.zen", "@@u", "%u", "@@"]);
  expect(reference).toEqual({ appId: "app.zen_browser.zen", branch: "beta", architecture: "x86_64", installation: "user" });
  expect(reference && flatpakInfoArguments(reference)).toEqual(["info", "--show-location", "--arch=x86_64", "--user", "app.zen_browser.zen", "beta"]);
  expect(parseFlatpakReference(["flatpak", "run", "--user", "--system", "app.zen_browser.zen"])).toBeUndefined();
});

test("recursive registration traversal stops at the actual entry budget", async () => {
  const f = await fixture(); try {
    const deep = join(f.root, "deep/a/b/c/d/e"); await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "tool.desktop"), "fixture");
    const scan = await boundedApplicationEntries(join(f.root, "deep"), 3);
    expect(scan.scanned).toBe(3); expect(scan.entries).toHaveLength(3); expect(scan.truncated).toBe(true);
    expect(scan.entries.some(entry => entry.endsWith("tool.desktop"))).toBe(false);
  } finally { await f.close(); }
});

test("expired enumeration never reads the tree or reports a complete inventory", async () => {
  const f = await fixture(); try {
    const scan = await boundedApplicationEntries(f.root, 4096, true, Date.now() - 1);
    expect(scan).toEqual({ entries: [], scanned: 0, truncated: true });
  } finally { await f.close(); }
});

test("unterminated desktop quoting cannot establish registration provenance", async () => {
  const f = await fixture(); try {
    const executable = await f.executable("painting-tool");
    await f.desktop("broken", `"${executable}`);
    expect((await discoverApplications(f.options)).applications).toEqual([]);
  } finally { await f.close(); }
});

test("namespace-visible running executables remain visible as unresolved metadata", async () => {
  const f = await fixture(); try {
    const pid = join(f.proc, "123"); await mkdir(pid); await symlink("/app/zen/zen", join(pid, "exe"));
    const inventory = await discoverApplications(f.options);
    expect(inventory.applications[0]).toMatchObject({ executable: "/app/zen/zen", availability: "unresolved", runningPids: [123], packaging: "unknown" });
  } finally { await f.close(); }
});

const flatpakTest = process.platform === "linux" && await Bun.file("/usr/bin/flatpak").exists() ? test : schemaTest.skip;
flatpakTest("stale Flatpak branches are omitted and distinct verified deployments do not collapse", async () => {
  const f = await fixture(); try {
    for (const branch of ["stable", "beta"]) {
      await mkdir(join(f.root, branch, "files"), { recursive: true });
      await f.desktop(`zen-${branch}`, `/usr/bin/flatpak run --branch=${branch} --user app.zen_browser.zen`);
    }
    const available = await discoverApplications({ ...f.options, metadataProbe: async ref => ref.branch === "stable" ? join(f.root, "stable") : undefined });
    expect(available.applications).toHaveLength(1); expect(available.applications[0]?.flatpak?.branch).toBe("stable");
    const both = await discoverApplications({ ...f.options, metadataProbe: async ref => join(f.root, ref.branch ?? "missing") });
    expect(both.applications).toHaveLength(2);
    expect(new Set(both.applications.map(app => app.flatpak?.deploymentFiles)).size).toBe(2);
  } finally { await f.close(); }
});

test("recent application metadata finds a moved app without returning document content", async () => {
  const f = await fixture(); try {
    const executable = await f.executable("painting-tool");
    const recentFile = join(f.root, "recent.xbel");
    await writeFile(recentFile, `<xbel><bookmark href="file:///private-document"><title>Private title</title><bookmark:application name="Painter" exec="&quot;${executable}&quot; /private-document" modified="2026-10-12T10:00:00Z"/></bookmark></xbel>`);
    const report = await discoverApplications({ ...f.options, recentFile });
    expect(report.applications[0]?.executable).toBe(executable);
    expect(report.applications[0]?.sources).toContain("recent-application-metadata");
    expect(report.applications[0]?.runningPids).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("private-document");
    expect(JSON.stringify(report)).not.toContain("Private title");
  } finally { await f.close(); }
});

test("version and channel require literal installed metadata, not a folder label", async () => {
  const f = await fixture(); try {
    const executable = await f.executable("zen");
    await mkdir(join(f.bin, "defaults/pref"), { recursive: true });
    await writeFile(join(f.bin, "application.ini"), "[App]\nVersion=1.23.2b\n");
    await writeFile(join(f.bin, "defaults/pref/channel-prefs.js"), 'pref("app.update.channel", "release");\n');
    const report = await discoverApplications(f.options);
    expect(report.applications[0]).toMatchObject({ executable, version: "1.23.2b", channel: "release" });
    expect(report.applications[0]?.channelSource).toBe(join(f.bin, "defaults/pref/channel-prefs.js"));
  } finally { await f.close(); }
});

schemaTest("unsupported platforms report no adapter instead of claiming universal support", async () => {
  const report = await discoverApplications({ platform: "freebsd" });
  expect(report.applications).toEqual([]); expect(report.notes.join(" ")).toContain("no adapter");
});


schemaTest("absent optional application roots do not abort discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-missing-applications-"));
  try {
    const absent = join(root, "not-installed");
    expect(await boundedApplicationEntries(absent)).toEqual({ entries: [], scanned: 0, truncated: false });
    const inventory = await discoverApplications({ platform: "linux", home: root,
      env: { HOME: root, PATH: "", XDG_DATA_DIRS: "" },
      applicationDirectories: [absent], includeRunning: false });
    expect(inventory).toMatchObject({ scope: "current-user", applications: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
