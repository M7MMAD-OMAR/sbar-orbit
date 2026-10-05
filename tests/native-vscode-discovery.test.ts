import { expect } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareVSCodeLaunch } from "../src/native-vscode";

const test = linuxOnlySuite("VS Code executable discovery belongs to the Linux private display");

async function installation() {
  const root = await mkdtemp(join(tmpdir(), "orbit-code-install-"));
  const app = join(root, "custom prefix", "visual-studio-code");
  const executable = join(app, "code");
  const session = join(root, "session");
  await mkdir(join(app, "resources", "app"), { recursive: true });
  await mkdir(session);
  await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  await writeFile(join(app, "resources", "app", "product.json"),
    JSON.stringify({ applicationName: "code", nameLong: "Visual Studio Code", dataFolderName: ".vscode" }));
  return { root, app, executable, session };
}

test("VS Code private launch uses an explicitly selected official installation", async () => {
  const f = await installation();
  try {
    const prepared = await prepareVSCodeLaunch(f.session, { extensions: [] }, {
      configHome: join(f.root, "config"), extensionsHome: join(f.root, "extensions"),
      executable: f.executable,
    });
    expect(prepared.argv[0]).toBe(f.executable);
    expect(prepared.argv).toContain("--user-data-dir");
    expect(prepared.argv).toContain("--extensions-dir");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("VS Code discovery follows the official code launcher through a PATH symlink", async () => {
  const f = await installation();
  try {
    const { discoverVSCodeExecutable } = await import("../src/native-vscode");
    const bin = join(f.root, "bin");
    await mkdir(bin);
    await mkdir(join(f.app, "bin"));
    await writeFile(join(f.app, "bin", "code"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await symlink(join(f.app, "bin", "code"), join(bin, "code"));
    expect(await discoverVSCodeExecutable({ path: bin })).toBe(f.executable);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("VS Code discovery refuses invalid explicit paths and different editor identities", async () => {
  const f = await installation();
  try {
    const { discoverVSCodeExecutable } = await import("../src/native-vscode");
    await expect(discoverVSCodeExecutable({ executable: "code" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(discoverVSCodeExecutable({ executable: join(f.root, "missing") })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await chmod(f.executable, 0o644);
    await expect(discoverVSCodeExecutable({ executable: f.executable })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await chmod(f.executable, 0o755);
    await writeFile(join(f.app, "resources", "app", "product.json"),
      JSON.stringify({ applicationName: "codium", nameLong: "VSCodium", dataFolderName: ".vscode-oss" }));
    await expect(discoverVSCodeExecutable({ executable: f.executable })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
