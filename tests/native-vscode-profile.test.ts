import { linuxOnlySuite } from "./platform-support";
import { expect, test as schemaTest } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseNativeAction } from "../src/fedora";

const test = linuxOnlySuite("native VS Code profiles belong to the Linux private display");

const selectedExtension = "pkief.material-icon-theme-5.38.1";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-vscode-profile-"));
  const configHome = join(root, "source-config");
  const extensionsHome = join(root, "source-extensions");
  const sessionDirectory = join(root, "session");
  const installation = join(root, "installed-code");
  const executable = join(installation, "code");
  await mkdir(join(installation, "resources", "app"), { recursive: true });
  await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  await writeFile(join(installation, "resources", "app", "product.json"),
    JSON.stringify({ applicationName: "code", nameLong: "Visual Studio Code", dataFolderName: ".vscode" }));
  const user = join(configHome, "Code", "User");
  const selected = join(extensionsHome, selectedExtension);
  await mkdir(join(user, "globalStorage"), { recursive: true });
  await mkdir(join(user, "snippets"), { recursive: true });
  await mkdir(selected, { recursive: true });
  await mkdir(join(extensionsHome, "other.extension-1.0.0"));
  await mkdir(sessionDirectory);
  const settings = Buffer.from('{"editor.fontSize":17,"files.autoSave":"afterDelay"}\n');
  const packageJson = Buffer.from('{"publisher":"pkief","name":"material-icon-theme","version":"5.38.1"}\n');
  await writeFile(join(user, "settings.json"), settings);
  await writeFile(join(user, "keybindings.json"), "[]\n");
  await writeFile(join(user, "snippets", "plain.code-snippets"), "{}\n");
  await writeFile(join(user, "globalStorage", "token.txt"), "do not copy this\n");
  await writeFile(join(selected, "package.json"), packageJson);
  await writeFile(join(selected, "extension.js"), "exports.activate = () => {};\n");
  await writeFile(join(extensionsHome, "other.extension-1.0.0", "package.json"), "{}\n");
  return { root, configHome, extensionsHome, sessionDirectory, executable, user, selected, settings, packageJson };
}

function privateFlag(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || !value) throw new Error(`Missing ${flag} argument`);
  return value;
}

schemaTest("launch-app accepts only a VS Code profile request, not caller launch arguments", () => {
  const valid = { type: "launch-app" as const, app: "vscode" as const, profile: "default" as const, extensions: [selectedExtension] };
  expect(parseNativeAction(valid)).toEqual(valid);
  for (const extra of [
    { argv: ["/usr/share/code/code", "--user-data-dir=/tmp/other-profile"] },
    { toolkit: "x11" },
    { selectedFiles: ["/tmp/file"] },
  ]) expect(() => parseNativeAction({ ...valid, ...extra })).toThrow();
  for (const name of ["../escape", "publisher/extension-1.0.0", "publisher\\extension-1.0.0", ".", ".."])
    expect(() => parseNativeAction({ ...valid, extensions: [name] })).toThrow();
  expect(() => parseNativeAction({ ...valid, openPath: "../project" })).toThrow();
  expect(() => parseNativeAction({ ...valid, extensions: [selectedExtension, selectedExtension] })).toThrow();
});

test("VS Code snapshot copies Default settings and one extension without account state", async () => {
  const f = await fixture();
  try {
    const { prepareVSCodeLaunch } = await import("../src/native-vscode");
    const prepared = await prepareVSCodeLaunch(f.sessionDirectory,
      { extensions: [selectedExtension] }, { configHome: f.configHome, extensionsHome: f.extensionsHome, executable: f.executable });
    expect(prepared.toolkit).toBe("wayland");
    expect(prepared.selectedFiles).toEqual([]);
    expect(prepared.snapshot).toEqual({ settings: "copied", accountState: "absent", extensions: [selectedExtension] });
    expect(prepared.argv[0]).toBe(f.executable);
    expect(prepared.argv).toContain("--new-window");
    expect(prepared.argv).not.toContain("--reuse-window");
    const data = privateFlag(prepared.argv, "--user-data-dir");
    const extensions = privateFlag(prepared.argv, "--extensions-dir");
    const sharedData = privateFlag(prepared.argv, "--shared-data-dir");
    expect(relative(f.sessionDirectory, data).startsWith("..")).toBe(false);
    expect(relative(f.sessionDirectory, extensions).startsWith("..")).toBe(false);
    expect(relative(f.sessionDirectory, sharedData).startsWith("..")).toBe(false);
    expect(data).not.toBe(f.configHome);
    expect(extensions).not.toBe(f.extensionsHome);
    expect(sharedData).not.toBe(data);
    expect((await stat(sharedData)).mode & 0o077).toBe(0);
    expect(await readFile(join(data, "User", "settings.json"))).toEqual(f.settings);
    expect(await readFile(join(extensions, selectedExtension, "package.json"))).toEqual(f.packageJson);
    expect(await readdir(extensions)).toEqual([selectedExtension]);
    expect(await readdir(join(data, "User"))).not.toContain("globalStorage");
    expect((await stat(data)).mode & 0o077).toBe(0);
    expect((await stat(join(data, "User", "settings.json"))).mode & 0o077).toBe(0);
    expect(await readFile(join(f.user, "settings.json"))).toEqual(f.settings);
    expect(await readFile(join(f.selected, "package.json"))).toEqual(f.packageJson);
    expect(await readFile(join(f.user, "globalStorage", "token.txt"), "utf8")).toBe("do not copy this\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("VS Code snapshot refuses a linked source settings file and leaves no copy", async () => {
  const f = await fixture();
  try {
    const { prepareVSCodeLaunch } = await import("../src/native-vscode");
    const outside = join(f.root, "outside-settings.json");
    await writeFile(outside, '{"secret":"not for Orbit"}\n');
    await rm(join(f.user, "settings.json"));
    await symlink(outside, join(f.user, "settings.json"));
    await expect(prepareVSCodeLaunch(f.sessionDirectory,
      { extensions: [selectedExtension] }, { configHome: f.configHome, extensionsHome: f.extensionsHome, executable: f.executable })).rejects.toThrow();
    expect(await readdir(f.sessionDirectory)).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe('{"secret":"not for Orbit"}\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("VS Code account snapshot includes an uncheckpointed SQLite login record", async () => {
  const f = await fixture();
  const source = join(f.user, "globalStorage", "state.vscdb");
  const database = new Database(source);
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);");
    database.query("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("secret://github.auth", "encrypted fixture");
    const { prepareVSCodeLaunch } = await import("../src/native-vscode");
    const prepared = await prepareVSCodeLaunch(f.sessionDirectory,
      { extensions: [] }, { configHome: f.configHome, extensionsHome: f.extensionsHome, executable: f.executable });
    expect(prepared.snapshot.accountState).toBe("copied");
    const snapshot = new Database(join(privateFlag(prepared.argv, "--user-data-dir"), "User", "globalStorage", "state.vscdb"));
    try {
      expect(snapshot.query("SELECT value FROM ItemTable WHERE key = ?").get("secret://github.auth"))
        .toEqual({ value: "encrypted fixture" });
    } finally { snapshot.close(); }
    expect(database.query("SELECT value FROM ItemTable WHERE key = ?").get("secret://github.auth"))
      .toEqual({ value: "encrypted fixture" });
  } finally { database.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("VS Code snapshot refuses a linked extension file and leaves no copy", async () => {
  const f = await fixture();
  try {
    const { prepareVSCodeLaunch } = await import("../src/native-vscode");
    const outside = join(f.root, "outside-extension.js");
    await writeFile(outside, "exports.activate = () => {};\n");
    await rm(join(f.selected, "extension.js"));
    await symlink(outside, join(f.selected, "extension.js"));
    await expect(prepareVSCodeLaunch(f.sessionDirectory,
      { extensions: [selectedExtension] }, { configHome: f.configHome, extensionsHome: f.extensionsHome, executable: f.executable })).rejects.toThrow();
    expect(await readdir(f.sessionDirectory)).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("exports.activate = () => {};\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("VS Code snapshot refuses more than 256 MiB of selected extension data", async () => {
  const f = await fixture();
  try {
    const { prepareVSCodeLaunch } = await import("../src/native-vscode");
    const large = await open(join(f.selected, "large.bin"), "w");
    try { await large.truncate(256 * 1024 * 1024 + 1); }
    finally { await large.close(); }
    await expect(prepareVSCodeLaunch(f.sessionDirectory,
      { extensions: [selectedExtension] }, { configHome: f.configHome, extensionsHome: f.extensionsHome, executable: f.executable })).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    expect(await readdir(f.sessionDirectory)).toEqual([]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
