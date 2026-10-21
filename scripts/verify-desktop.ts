/** The supported product suite no longer launches retired standalone browsers. */
export {};
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const requested = process.argv.slice(2);
const files = requested.length ? requested : [
  "tests/desktop-only.test.ts",
  "tests/session-visibility.test.ts",
  "tests/application-launch.test.ts",
  "tests/installed-launch.test.ts",
  "tests/installed-launch-native.test.ts",
  "tests/desktop-workspaces.test.ts",
  "tests/mcp.test.ts",
  "tests/ci-desktop.test.ts",
  "tests/application-discovery.test.ts",
  "tests/application-discovery-native.test.ts",
  "tests/policy.test.ts",
  "tests/socket-acl.test.ts",
  "tests/resources.test.ts",
  "tests/source-manifest.test.ts",
  "tests/update-admission.test.ts",
  "tests/preflight.test.ts",
  "tests/sway-ipc.test.ts",
  "tests/native-handoff-release.test.ts",
  "tests/native-transport.test.ts",
  "tests/native-keyboard.test.ts",
  "tests/native-paste.test.ts",
  "tests/native-action-control.test.ts",
  "tests/native-cleanup-control.test.ts",
  "tests/native-mapping.test.ts",
  "tests/native-data-control.test.ts",
  "tests/process-scope.test.ts",
  "tests/workspace-storage.test.ts",
  "tests/native-accessibility.test.ts",
  "tests/semantic-taint.test.ts",
  "tests/compositor-smoke.test.ts",
  "tests/native-window.test.ts",
];
// Native acceptance fixtures explicitly enable hidden mode in their own settings. Never change
// the person's setting, and never add a production environment-variable bypass for the tests.
const fixtureConfig = await mkdtemp(join(tmpdir(), "orbit-verify-settings-"));
try {
  await mkdir(join(fixtureConfig, "sbar-orbit"), { mode: 0o700 });
  await writeFile(join(fixtureConfig, "sbar-orbit/panel.json"), JSON.stringify({ hiddenSessions: true }), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--smol", "run", "scripts/limited.ts", process.execPath, "--smol", "test", ...files], {
    env: { ...process.env, XDG_CONFIG_HOME: fixtureConfig },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally { await rm(fixtureConfig, { recursive: true, force: true }); }
