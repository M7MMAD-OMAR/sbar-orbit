import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatCodexOwnerDryRun, prepareCodexOwnerLaunch } from "../src/codex-owner-launch";
import { writeStagedCodexCandidateManifest } from "../src/native-codex-candidate";

async function fixture() {
  const sandbox = await mkdtemp("/var/tmp/orbit-owner-launch-test-");
  const home = join(sandbox, "home");
  const configDirectory = join(home, ".config", "sbar-orbit");
  const candidateBase = join(home, ".local", "share", "sbar-orbit", "codex-candidates");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(candidateBase, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(candidateBase, "candidate-"));
  const app = join(root, "app");
  const source = join(sandbox, "source");
  const feature = join(app, ".codex-linux", "features", "shared-app-server-socket");
  await mkdir(feature, { recursive: true, mode: 0o700 });
  await mkdir(join(app, "resources"), { mode: 0o700 });
  await mkdir(join(source, "resources"), { recursive: true, mode: 0o700 });
  const executable = join(app, "ChatGPT");
  await writeFile(executable, "fixture desktop binary", { mode: 0o700 });
  await writeFile(join(app, "version"), "42.3.0", { mode: 0o600 });
  await writeFile(join(app, "resources", "app.asar"), "patched fixture ASAR", { mode: 0o600 });
  await writeFile(join(app, "resources", "codex"), "patched fixture CLI", { mode: 0o700 });
  await writeFile(join(feature, "orphan-reaper.js"), "fixture", { mode: 0o600 });
  await writeFile(join(feature, "sidebar-state-bridge.js"), "fixture", { mode: 0o600 });
  await writeFile(join(source, "ChatGPT"), "fixture desktop binary", { mode: 0o700 });
  await writeFile(join(source, "version"), "42.3.0", { mode: 0o600 });
  await writeFile(join(source, "resources", "app.asar"), "original fixture ASAR", { mode: 0o600 });
  const { manifestSha256 } = await writeStagedCodexCandidateManifest(executable, source, home);
  const configPath = join(configDirectory, "codex-owner.json");
  const config = { format: "orbit-codex-owner-v1", candidateExecutable: executable, manifestSha256 };
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { sandbox, home, source, app, executable, configPath, configDirectory, config, candidateBase };
}

test("Codex owner launcher selects a pinned durable candidate and keeps personal environment", async () => {
  const f = await fixture();
  try {
    const inheritedEnv = {
      HOME: f.home, CODEX_HOME: join(f.home, ".codex"), XDG_CONFIG_HOME: join(f.home, ".config"),
      XDG_DATA_HOME: join(f.home, ".local", "share"), SECRET_VALUE: "sensitive fixture value",
      CODEX_CLI_PATH: "/stale/cli", CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1",
    };
    const urls = ["codex://thread/fixture", "https://example.test/fixture"];
    const plan = await prepareCodexOwnerLaunch(urls, {
      home: f.home, sourceRoot: f.source, inheritedEnv,
    });
    expect(plan.choice).toBe("candidate");
    expect(plan.executable).toBe(f.executable);
    expect(plan.args).toEqual([
      "--enable-features=UseOzonePlatform", "--ozone-platform=wayland", "--enable-wayland-ime", ...urls,
    ]);
    expect(plan.env.HOME).toBe(f.home);
    expect(plan.env.CODEX_HOME).toBe(inheritedEnv.CODEX_HOME);
    expect(plan.env.XDG_CONFIG_HOME).toBe(inheritedEnv.XDG_CONFIG_HOME);
    expect(plan.env.XDG_DATA_HOME).toBe(inheritedEnv.XDG_DATA_HOME);
    expect(plan.env.CODEX_CLI_PATH).toBe(join(f.app, "resources", "codex"));
    expect(plan.env.CODEX_LINUX_APP_DIR).toBe(f.app);
    expect(plan.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET)
      .toBe(`/run/user/${process.getuid?.()}/codex-desktop/app-server-bridge/app-server.sock`);
    expect(plan.env.CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY).toBeUndefined();
    expect(formatCodexOwnerDryRun(plan)).toBe(JSON.stringify({
      choice: "candidate", setEnvKeys: [
        "CODEX_CLI_PATH", "CODEX_LINUX_APP_DIR", "CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET",
      ],
    }));
    expect(formatCodexOwnerDryRun(plan)).not.toContain("sensitive fixture value");
    expect(formatCodexOwnerDryRun(plan)).not.toContain(f.home);
  } finally { await rm(f.sandbox, { recursive: true, force: true }); }
});

test("Codex owner launcher falls back to the original after candidate bytes change", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.app, "resources", "codex"), "changed fixture CLI");
    const plan = await prepareCodexOwnerLaunch(["file:///tmp/fixture.csv"], {
      home: f.home, sourceRoot: f.source,
      inheritedEnv: { HOME: f.home, CODEX_HOME: join(f.home, ".codex"),
        CODEX_CLI_PATH: "/stale/cli", CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: "/stale/socket",
        CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1" },
    });
    expect(plan.choice).toBe("original");
    expect(plan.executable).toBe("/usr/lib/chatgpt/ChatGPT");
    expect(plan.args.at(-1)).toBe("file:///tmp/fixture.csv");
    expect(plan.env.HOME).toBe(f.home);
    expect(plan.env.CODEX_HOME).toBe(join(f.home, ".codex"));
    expect(plan.env.CODEX_CLI_PATH).toBeUndefined();
    expect(plan.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET).toBeUndefined();
    expect(plan.env.CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY).toBeUndefined();
    expect(formatCodexOwnerDryRun(plan)).toBe('{"choice":"original","setEnvKeys":[]}');
  } finally { await rm(f.sandbox, { recursive: true, force: true }); }
});

test("Codex owner launcher rejects linked or public configuration and temporary candidates", async () => {
  const f = await fixture();
  try {
    await chmod(f.configDirectory, 0o755);
    expect((await prepareCodexOwnerLaunch([], { home: f.home, sourceRoot: f.source })).choice).toBe("original");
    await chmod(f.configDirectory, 0o700);
    await rm(f.configPath);
    await symlink(join(f.sandbox, "other.json"), f.configPath);
    expect((await prepareCodexOwnerLaunch([], { home: f.home, sourceRoot: f.source })).choice).toBe("original");
    await rm(f.configPath);
    await writeFile(f.configPath, JSON.stringify({ ...f.config,
      candidateExecutable: "/var/tmp/other-candidate/app/ChatGPT" }), { mode: 0o600 });
    expect((await prepareCodexOwnerLaunch([], { home: f.home, sourceRoot: f.source })).choice).toBe("original");
  } finally { await rm(f.sandbox, { recursive: true, force: true }); }
});

test("Codex owner launcher accepts URLs only", async () => {
  await expect(prepareCodexOwnerLaunch(["--user-data-dir=/tmp/other"]))
    .rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

test("Codex owner command dry run prints a safe fallback choice without launching", async () => {
  const f = await fixture();
  try {
    await rm(f.configPath);
    const command = new URL("../scripts/launch-codex-owner.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "run", command, "--dry-run", "codex://thread/fixture"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: f.home, SECRET_VALUE: "sensitive fixture value" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe('{"choice":"original","setEnvKeys":[]}');
    expect(output).not.toContain(f.home);
    expect(output).not.toContain("sensitive fixture value");
  } finally { await rm(f.sandbox, { recursive: true, force: true }); }
});
