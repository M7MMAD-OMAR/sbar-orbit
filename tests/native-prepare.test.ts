import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const managerAvailable = process.platform === "linux" && !!process.env.XDG_RUNTIME_DIR
  && !!Bun.which("systemctl")
  && Bun.spawnSync(["systemctl", "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test.skipIf(!managerAvailable)("native preparation environment loads through a real user unit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbit-native-environment-"));
  const bundle = join(directory, "bundle %u space");
  const unitName = `orbit-native-environment-${crypto.randomUUID()}.service`;
  const unitDirectory = join(process.env.XDG_RUNTIME_DIR ?? "", "systemd/user");
  const unitPath = join(unitDirectory, unitName);
  const output = join(directory, "environment.json");
  const probe = join(directory, "probe.py");
  async function command(args: string[]) {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr}`);
    return stdout;
  }
  try {
    await mkdir(bundle, { mode: 0o700 });
    await command(["/usr/bin/python3", "-c", [
      "import sys",
      "from pathlib import Path",
      "from unittest.mock import patch",
      "sys.path.insert(0, sys.argv[1])",
      "from src.native import prepare",
      "with patch.object(prepare, 'inspect_host', return_value={'compositor': [1, 2], 'abi_hash': 'test-only'}), patch.object(prepare, 'verify_host'):",
      "    prepare.prepare(Path(sys.argv[2]), {})",
    ].join("\n"), join(import.meta.dir, ".."), bundle]);
    await writeFile(probe, [
      "import json, os, sys",
      "with open(sys.argv[1], 'w') as output:",
      "    json.dump({key: os.environ.get(key) for key in ('ORBIT_NATIVE_PLAN', 'ORBIT_NATIVE_CONTROL')}, output)",
    ].join("\n"), { mode: 0o600 });
    await mkdir(unitDirectory, { recursive: true });
    const template = await readFile(join(bundle, "service-drop-in.conf"), "utf8");
    await writeFile(unitPath, `${template}Type=oneshot\nExecStart=/usr/bin/python3 ${probe} ${output}\n`, { mode: 0o600, flag: "wx" });
    await command(["systemctl", "--user", "daemon-reload"]);
    await command(["systemctl", "--user", "start", unitName]);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      ORBIT_NATIVE_PLAN: join(bundle, "host.json"),
      ORBIT_NATIVE_CONTROL: join(bundle, "control"),
    });
  } finally {
    const stop = Bun.spawn(["systemctl", "--user", "stop", unitName], { stdout: "ignore", stderr: "ignore" });
    await stop.exited;
    await rm(unitPath, { force: true });
    await command(["systemctl", "--user", "daemon-reload"]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test.each([
  { args: [] },
  { args: ["relative"] },
  { args: ["/unused-owner-preparation", "full"] },
  { args: ["/unused-owner-preparation", "--plugin-manifest"] },
  { args: ["/unused-owner-preparation", "--plugin-manifest", "relative"] },
  { args: ["/unused-owner-preparation", "--plugin-manifest", "/unused", "extra"] },
])("native preparation rejects invalid owner arguments before host access", async ({ args }) => {
  const env = { ...process.env };
  delete env.ORBIT_CONVERSATION_ID;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "native-prepare", ...args],
    { env, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(JSON.parse(error)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});
