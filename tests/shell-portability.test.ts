import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dir, "..");
const shellTest = test.skipIf(process.platform === "win32");

async function fixture(options: { bsdReadlink: boolean; bunOnPath: boolean }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orbit portable home ")));
  const source = join(root, "checkout with spaces");
  const path = join(root, "tools");
  const bunHome = join(root, "custom bun location");
  await Promise.all([mkdir(join(source, "bin"), { recursive: true }), mkdir(path), mkdir(join(bunHome, "bin"), { recursive: true })]);
  await Promise.all([copyFile(join(project, "install.sh"), join(source, "install.sh")), copyFile(join(project, "bin/sbar-orbit"), join(source, "bin/sbar-orbit"))]);
  const tool = async (name: string, text: string) => writeFile(join(path, name), text, { mode: 0o755 });
  for (const name of ["bash", "dirname", "basename", "cat"])
    await symlink(Bun.which(name) ?? `/usr/bin/${name}`, join(path, name));
  const readlink = Bun.which("readlink") ?? "/usr/bin/readlink";
  if (options.bsdReadlink)
    await tool("readlink", `#!/bin/sh\n[ "$#" -eq 1 ] || exit 64\nexec '${readlink}' "$1"\n`);
  else await symlink(readlink, join(path, "readlink"));
  await tool("uname", "#!/bin/sh\nprintf '%s\\n' Darwin\n");
  const bun = join(bunHome, "bin/bun");
  await writeFile(bun, "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\"\n", { mode: 0o755 });
  if (options.bunOnPath) await symlink(bun, join(path, "bun"));
  // Relative links stand in for a package manager's stable command and version directory.
  await symlink("checkout with spaces/install.sh", join(root, "install link"));
  await symlink("checkout with spaces/bin/sbar-orbit", join(root, "orbit link"));
  const run = async (entry: string, args: string[]) => {
    const child = Bun.spawn([Bun.which("bash") ?? "/bin/bash", join(root, entry), ...args], {
      cwd: root, env: { ...process.env, HOME: root, BUN_INSTALL: bunHome, PATH: path }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  return { source, root, run, dispose: () => rm(root, { recursive: true, force: true }) };
}

shellTest("installer follows relative symlinks without GNU readlink flags", async () => {
  const box = await fixture({ bsdReadlink: true, bunOnPath: true });
  try {
    const result = await box.run("install link", ["--dry-run", "--prefix", "another path"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split("\n")).toEqual([box.source, "run", "scripts/limited.ts", "bun", "run", "scripts/install.ts", "--dry-run", "--prefix", "another path", ""]);
  } finally { await box.dispose(); }
});

shellTest("launcher follows relative symlinks without GNU readlink flags", async () => {
  const box = await fixture({ bsdReadlink: true, bunOnPath: true });
  try {
    const result = await box.run("orbit link", ["status", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split("\n")).toEqual([box.root, "run", join(box.source, "src/cli.ts"), "status", "--json", ""]);
  } finally { await box.dispose(); }
});

shellTest("installer finds Bun outside PATH at a custom location with spaces", async () => {
  const box = await fixture({ bsdReadlink: false, bunOnPath: false });
  try {
    const result = await box.run("install link", ["--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(box.source);
    expect(result.stdout).toContain("scripts/install.ts\n--json\n");
  } finally { await box.dispose(); }
});
