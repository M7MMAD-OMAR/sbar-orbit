# Release readiness work

Goal: one clear installation command per supported operating system, working agent
connections, realistic application tests, and measured resource and recovery behavior.
Unsupported capabilities must remain explicit; no finite test matrix proves every device.

## Acceptance checklist

- [ ] Fresh installation starts a usable broker immediately on Linux, Windows and macOS.
- [ ] Installation offers an explicit, repeatable way to register supported agent hosts,
      preserving unrelated configuration and reporting unsupported hosts.
- [ ] Published commands work from a clean source archive and handle missing prerequisites.
- [ ] Cross-platform CI fails on type errors, failing tests and failed runtime checks.
- [ ] Browser and MCP flows verify navigation, text, capture, pause/resume and cleanup.
- [ ] Native application flows run on supported Linux hosts; platform refusals are tested.
- [ ] Resource use, concurrent sessions and crash recovery have current recorded evidence.
- [ ] Release documentation, support table and package commands agree with verified behavior.

## Current findings

- Existing platform workflows deliberately tolerate failures and several shell commands
  replace a failed command's exit status with a successful echo.
- Windows installation registers a next-logon task but does not start the broker now.
- Installation writes Orbit's connector configuration but leaves host registration manual.
- Native-enabled local baseline is running; its result will be recorded after completion.

Record each platform's revision, command, result and limits. A skipped test is not a pass.
