import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { OrbitError } from "./errors";

const maximumBytes = 256 * 1024 * 1024;
const maximumFileBytes = 64 * 1024 * 1024;
const maximumFiles = 10000;
const extensionName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type VSCodeProfileRequest = { extensions: string[]; openPath?: string };
export type VSCodeProfileSource = { configHome: string; extensionsHome: string };
export type VSCodeProfileSnapshot = { settings: "copied" | "absent"; accountState: "copied" | "absent"; extensions: string[] };

export function validateVSCodeProfileRequest(request: VSCodeProfileRequest) {
  if (!Array.isArray(request.extensions) || request.extensions.length > 4 ||
      request.extensions.some(name => typeof name !== "string" || !extensionName.test(name) || name.includes("..")) ||
      new Set(request.extensions).size !== request.extensions.length)
    throw new OrbitError("INVALID_REQUEST", "Select up to four exact VS Code extension folder names");
  if (request.openPath !== undefined &&
      (typeof request.openPath !== "string" || !isAbsolute(request.openPath) ||
       request.openPath.length > 4096 || request.openPath.includes("\0")))
    throw new OrbitError("INVALID_REQUEST", "VS Code openPath must be an absolute path");
}

/** Snapshot selected preferences, account database and extensions into private paths. */
export async function prepareVSCodeLaunch(
  sessionDirectory: string,
  request: VSCodeProfileRequest,
  source: VSCodeProfileSource = {
    configHome: process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    extensionsHome: process.env.VSCODE_EXTENSIONS || join(homedir(), ".vscode", "extensions"),
  },
): Promise<{ argv: string[]; toolkit: "wayland"; selectedFiles: string[]; snapshot: VSCodeProfileSnapshot }> {
  validateVSCodeProfileRequest(request);
  let openPath = request.openPath;
  if (openPath !== undefined) {
    let metadata;
    try {
      openPath = await realpath(openPath);
      metadata = await stat(openPath);
    }
    catch { throw new OrbitError("INVALID_REQUEST", "VS Code openPath does not exist"); }
    if (!metadata.isFile() && !metadata.isDirectory())
      throw new OrbitError("INVALID_REQUEST", "VS Code openPath must be a file or directory");
  }
  const root = join(sessionDirectory, `vscode-${crypto.randomUUID()}`);
  const data = join(root, "data");
  const extensions = join(root, "extensions");
  const sharedData = join(root, "shared-data");
  const sourceUser = join(source.configHome, "Code", "User");
  const targetUser = join(data, "User");
  const budget = { bytes: 0, files: 0 };

  async function requirePlainDirectory(path: string) {
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new OrbitError("UNSUPPORTED", "VS Code profile source directory must not be linked");
    if (await realpath(path) !== resolve(path))
      throw new OrbitError("UNSUPPORTED", "VS Code profile source directory resolves through a link");
  }

  async function copyRegular(from: string, to: string): Promise<boolean> {
    let file;
    try { file = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1)
        throw new OrbitError("UNSUPPORTED", "VS Code snapshot source must contain regular files without hard links");
      if (++budget.files > maximumFiles || before.size > maximumFileBytes ||
          budget.bytes + before.size > maximumBytes)
        throw new OrbitError("LIMIT_REACHED", "VS Code snapshot exceeds its file or byte limit");
      budget.bytes += before.size;
      const contents = await file.readFile();
      const after = await file.stat();
      const current = await lstat(from);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs)
        throw new OrbitError("BACKEND_FAILED", "VS Code source changed during the snapshot");
      await writeFile(to, contents, { flag: "wx", mode: before.mode & 0o111 ? 0o700 : 0o600 });
      return true;
    } finally { await file.close(); }
  }

  async function copyDirectory(from: string, to: string): Promise<boolean> {
    let metadata;
    try { metadata = await lstat(from); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new OrbitError("UNSUPPORTED", "VS Code snapshot source directory must not be linked");
    await mkdir(to, { mode: 0o700 });
    for (const entry of (await readdir(from)).sort()) {
      const child = join(from, entry);
      const target = join(to, entry);
      const info = await lstat(child);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (!await copyDirectory(child, target))
          throw new OrbitError("BACKEND_FAILED", "VS Code extension changed during the snapshot");
      }
      else if (info.isFile() && !info.isSymbolicLink()) {
        if (!await copyRegular(child, target))
          throw new OrbitError("BACKEND_FAILED", "VS Code extension changed during the snapshot");
      }
      else throw new OrbitError("UNSUPPORTED", "VS Code snapshot source contains a link or special file");
    }
    return true;
  }

  async function copySqlite(from: string, to: string): Promise<boolean> {
    let before;
    try { before = await lstat(from); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new OrbitError("UNSUPPORTED", "VS Code account database must be a regular file without hard links");
    if (++budget.files > maximumFiles || before.size > maximumFileBytes ||
        budget.bytes + before.size > maximumBytes)
      throw new OrbitError("LIMIT_REACHED", "VS Code snapshot exceeds its file or byte limit");
    budget.bytes += before.size;
    await mkdir(dirname(to), { mode: 0o700 });
    const child = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "native/sqlite_snapshot.py"), from, to],
      { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      if (await child.exited !== 0)
        throw new OrbitError("BACKEND_FAILED", "VS Code account database could not be snapshotted");
      const after = await lstat(from);
      if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile())
        throw new OrbitError("BACKEND_FAILED", "VS Code account database changed identity during the snapshot");
      return true;
    } finally { clearTimeout(timer); }
  }

  try {
    await requirePlainDirectory(source.configHome);
    await requirePlainDirectory(join(source.configHome, "Code"));
    await requirePlainDirectory(sourceUser);
    await requirePlainDirectory(join(sourceUser, "globalStorage"));
    if (request.extensions.length) await requirePlainDirectory(source.extensionsHome);
    await mkdir(root, { mode: 0o700 });
    await mkdir(data, { mode: 0o700 });
    await mkdir(targetUser, { mode: 0o700 });
    await mkdir(extensions, { mode: 0o700 });
    await mkdir(sharedData, { mode: 0o700 });
    const settings = await copyRegular(join(sourceUser, "settings.json"), join(targetUser, "settings.json"))
      ? "copied" : "absent";
    await copyRegular(join(sourceUser, "keybindings.json"), join(targetUser, "keybindings.json"));
    await copyDirectory(join(sourceUser, "snippets"), join(targetUser, "snippets"));
    await copyRegular(join(source.configHome, "Code", "Local State"), join(data, "Local State"));
    await copyRegular(join(source.configHome, "Code", "machineid"), join(data, "machineid"));
    const accountState = await copySqlite(join(sourceUser, "globalStorage", "state.vscdb"),
      join(targetUser, "globalStorage", "state.vscdb")) ? "copied" : "absent";
    for (const name of request.extensions)
      if (!await copyDirectory(join(source.extensionsHome, name), join(extensions, name)))
        throw new OrbitError("INVALID_REQUEST", `VS Code extension folder does not exist: ${name}`);
    return {
      argv: ["/usr/share/code/code", "--user-data-dir", data, "--extensions-dir", extensions,
        "--shared-data-dir", sharedData,
        "--new-window", ...(openPath ? [openPath] : [])],
      toolkit: "wayland",
      selectedFiles: [],
      snapshot: { settings, accountState, extensions: [...request.extensions] },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
