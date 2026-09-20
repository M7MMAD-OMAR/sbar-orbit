# Platform verification without a local Mac

Run `bun run verify:platform-contracts` from the checkout. This bounded command
runs the portable macOS path, browser argument, Keychain switch and platform
contracts, plus a service lifecycle simulation. It is useful on Linux even when
no Mac is available. Tests requiring a real Darwin kernel are explicitly skipped.

The service simulation uses actual temporary files and production installation
functions. Only the `launchctl` subprocess response is simulated. It checks first
installation, repeated installation, bootstrap failure, status, removal, missing
launchers and preservation of unrelated files. It cannot establish that launchd
accepts the plist or that the real service starts. Windows skips this Unix UID
simulation; its managed service has separate real-VM coverage.

For real macOS verification without owning a Mac, use the repository's GitHub
Actions `verify` workflow. GitHub provides a fresh macOS VM for each hosted job:
https://docs.github.com/en/actions/reference/runners/github-hosted-runners
The workflow tests the actual Darwin kernel, browser, installed broker and MCP
entries. These results complement the portable contracts rather than replacing
them. A cloud runner still does not prove behavior on every physical Mac or on a
person's existing Keychain and desktop account.

Do not change `process.platform` and describe a Linux process as a measured Mac.
Do not remove a failing test merely to obtain a passing run. Keep kernel-only
coverage and report skips separately. Diagnose failures from their retained logs;
a successful rerun does not explain an earlier intermittent failure.
