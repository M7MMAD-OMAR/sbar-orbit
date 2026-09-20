import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BROKER_LABEL, disableLaunchAgent, enableLaunchAgent, launchAgentPath } from "../src/macos-autostart";

// Filesystem integration with a simulated launchctl. This does not test launchd,
// kernel scheduling, Keychain, or a real macOS login session.
const unixTest = process.getuid ? test : test.skip;
unixTest("simulated macOS service installation, replacement, refusal and removal preserve their contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-macos-service-"));
  const home = join(root, "example & spaces");
  const launcher = join(root, "orbit launcher");
  const socket = join(root, "broker.sock");
  const env = {} as NodeJS.ProcessEnv;
  const calls: string[][] = [];
  let loaded = false;
  let rejectBootstrap = false;
  const spawn = Bun.spawn.bind(Bun);
  const intercepted = spyOn(Bun, "spawn").mockImplementation(((command: unknown) => {
    if (!Array.isArray(command) || command[0] !== "/bin/launchctl")
      throw new Error("Unexpected subprocess in service simulation");
    const args = command.slice(1) as string[];
    calls.push(args);
    let code = 0;
    let output = "";
    if (args[0] === "bootout") { code = loaded ? 0 : 3; loaded = false; }
    else if (args[0] === "bootstrap") {
      code = rejectBootstrap ? 5 : 0;
      loaded = !rejectBootstrap;
      output = rejectBootstrap ? "Bootstrap failed: 5" : "";
    } else if (args[0] === "print") {
      code = loaded ? 0 : 3;
      output = loaded ? "state = running" : "Could not find service";
    } else throw new Error(`Unexpected launchctl operation: ${args[0]}`);
    return spawn([process.execPath, "-e", `console.log(${JSON.stringify(output)});process.exit(${code})`],
      { stdout: "pipe", stderr: "pipe" });
  }) as typeof Bun.spawn);
  try {
    await writeFile(launcher, "fixture");
    const first = await enableLaunchAgent(launcher, socket, home, env);
    expect(first.bootstrapped).toBe(true);
    expect(first.status.running).toBe(true);
    expect(first.status.startsAtBoot).toBe(false);
    const path = launchAgentPath(home, env);
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("example &amp; spaces");
    expect(calls.slice(0, 3)).toEqual([
      ["bootout", `gui/${process.getuid?.()}/${BROKER_LABEL}`],
      ["bootstrap", `gui/${process.getuid?.()}`, path],
      ["print", `gui/${process.getuid?.()}/${BROKER_LABEL}`],
    ]);
    const again = await enableLaunchAgent(launcher, socket, home, env);
    expect(again.bootstrapped).toBe(true);
    expect(await readFile(path, "utf8")).toBe(contents);
    expect(await readdir(join(home, "Library", "LaunchAgents"))).toEqual([`${BROKER_LABEL}.plist`]);

    rejectBootstrap = true;
    const rejected = await enableLaunchAgent(launcher, socket, home, env);
    expect(rejected.bootstrapped).toBe(false);
    expect(rejected.status.loaded).toBe(false);
    expect(rejected.status.running).toBe(false);
    expect(rejected.status.plistPresent).toBe(true);
    expect(rejected.output).toContain("Bootstrap failed");

    const removed = await disableLaunchAgent(home, env);
    expect(removed.removed).toEqual([path]);
    expect(removed.status.plistPresent).toBe(false);
    expect((await disableLaunchAgent(home, env)).removed).toEqual([]);

    await writeFile(path, "unrelated user configuration");
    const beforeForeignRemoval = calls.length;
    await expect(disableLaunchAgent(home, env)).rejects.toThrow(/not written by Orbit/);
    expect(calls).toHaveLength(beforeForeignRemoval);
    expect(await readFile(path, "utf8")).toBe("unrelated user configuration");
    const before = calls.length;
    await expect(enableLaunchAgent(join(root, "absent"), socket, home, env)).rejects.toThrow(/regular file/);
    expect(calls).toHaveLength(before);
  } finally {
    intercepted.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
