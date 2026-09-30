# 0.2.0

A checkpoint release of Orbit after the application integration work since
0.1.1. The independent browser and desktop remain the product boundary.
The larger goal of full parity with every current application, account,
conversation, file permission and device is incomplete.

## Included work

- Browser navigation, font capture and file upload corrections, including
  portable upload file names on Windows.
- Expanded private desktop keyboard input and preference snapshots.
- Native application profile, credential and file access admission checks.
- Explicit authority gates for experimental Codex attachment and owner routing.
- Regression coverage for private IPC, outbound connection handling, process
  cleanup and application admission failures.
- CI fixtures now gate Linux native subjects on Linux, retain shorter Unix
  socket paths on macOS, and probe GI, bubblewrap namespaces and Landlock
  ABI before requiring runtime-specific integration checks. Socket replacement
  fixtures retain the old inode so allocator reuse cannot hide replacement.

The source archive includes the stopped research checkpoint and its evidence.
The registry package does not include the experimental application harnesses.
Experimental private PID and seccomp broker work is not a production-wide
application isolation policy. Native Codex attachment and current conversations
remain conditional and experimental. Installation is not proof of account,
conversation, device or application parity.

## Verification

Local Fedora verification: 589 passed, 27 skipped, 0 failed, 616 tests across
129 files with `ORBIT_TEST_NATIVE=1`, in 187.64 seconds. Typecheck passed.
Release checks and archive checksums are recorded on the GitHub release.
A skipped check remains not measured. Existing support tiers still apply;
see [support tiers](support-tiers.md) and [validation](validation.md).

## Install

```sh
bun add -g https://github.com/M7MMAD-OMAR/sbar-orbit/releases/download/v0.2.0/sbar-orbit-0.2.0.tgz
sbar-orbit install --connect auto
```

This release is distributed on GitHub. Registry publication is not claimed.

For a source checkout:

```sh
git clone --branch v0.2.0 https://github.com/M7MMAD-OMAR/sbar-orbit
cd sbar-orbit
./install.sh --connect auto
```

Windows uses `install.cmd --connect auto`. Follow the installer prerequisites
and platform limits in the repository. An upgrade can close existing Orbit
sessions when the broker is restarted; close them before an explicit upgrade.
This release publication does not restart the workstation's broker or change
its installed version.
