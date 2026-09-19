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
- Windows installation now requests immediate startup and verifies the broker.
  Account-specific task names fix a measured collision with another account's task.
  The installed browser flow passes on Windows and Linux; see
  [installed command acceptance](fragments/installed-command-acceptance.md).
- Installation writes Orbit's connector configuration but leaves host registration manual.
- Local baseline on 19 September 2026 at runtime revision `8874e63`:
  `ORBIT_TEST_NATIVE=1 bun run verify`: 424 pass, 25 skip, 0 fail,
  449 tests across 88 files in 133.35 seconds. Typecheck also passes.
- Strict three-platform workflow added in `fc5071a`. Publishing it was refused by
  GitHub because the current OAuth app lacks `workflow` scope. No remote run of
  this new workflow exists yet. This does not block local installer work.

Record each platform's revision, command, result and limits. A skipped test is not a pass.
