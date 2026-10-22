/** Native-only suite. Never starts a browser or a substitute display. */
export {};
const requested = process.argv.slice(2);
const files = requested.length ? requested : [
  "tests/architecture.test.ts", "tests/native-only.test.ts", "tests/native-window-geometry.test.ts", "tests/native-open.test.ts", "tests/native-opening-identity.test.ts", "tests/native-existing.test.ts",
  "tests/native-worker.test.ts", "tests/native-plugin-compatibility.test.ts", "tests/native-plugin-owner.test.ts", "tests/native-indicator-style.test.ts", "tests/native-presentation.test.ts", "tests/native-action-control.test.ts",
  "tests/native-cleanup-control.test.ts", "tests/native-capture-uv.test.ts", "tests/native-keyboard-focus.test.ts", "tests/native-handoff-focus.test.ts", "tests/native-window-lifecycle.test.ts", "tests/native-pointer-geometry.test.ts", "tests/native-shared-clipboard.test.ts", "tests/native-data-control.test.ts",
  "tests/application-launch.test.ts", "tests/application-discovery.test.ts", "tests/application-discovery-native.test.ts",
  "tests/policy.test.ts", "tests/diagnostic-codes.test.ts", "tests/settings.test.ts", "tests/socket-acl.test.ts", "tests/resources.test.ts",
  "tests/source-manifest.test.ts", "tests/install.test.ts", "tests/connector-entry.test.ts", "tests/host-registration.test.ts", "tests/update-admission.test.ts", "tests/preflight.test.ts",
  "tests/process-scope.test.ts", "tests/workspace-storage.test.ts",
];
const child = Bun.spawn([process.execPath, "--smol", "run", "scripts/limited.ts", process.execPath, "--smol", "test", ...files], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exitCode = await child.exited;
