# Disposable Codex candidate and owner dry run

Measured on 29 September 2026 without launching the candidate or reading a
personal Codex profile. This prepares a reviewable file set, not an approved
or production owner cutover.

The installed Desktop reports version `42.3.0`. Its `ChatGPT` executable has
SHA-256 `3ac47769a211d64007c7dd072142cd32f9cbea0aaeb5d1e632eec507689fa7a2`.
The installed `app.asar` has SHA-256
`8889a6e9aeba678a5d77876bcc9cfce3168ab47cc7bb4ba5856f80a3a32157a8`.
A user-owned copy of the installed application was made in
`/var/tmp/orbit-codex-candidate-review/app`. Only that copy received the
previously tested fixture Desktop ASAR, the source-only bridge feature files,
and the experimental combined Codex CLI. The installed files were not edited.

The initial 2.1 GB debug CLI exceeded the verifier's 512 MB per-file limit.
`strip --strip-debug` left it at 1.0 GB. `strip --strip-all` reduced the copied
CLI to 389,114,360 bytes, below the limit. It still reported
`codex-cli 0.155.0-alpha.9.2`; its SHA-256 became
`e3956365e3ebfab70fb70a3e41e75d38ed0cba534cc87e78684efa0be943af3f`.
The complete copied `app` contained 1,511,991,031 regular-file bytes, below
the verifier's 4 GB tree limit.

`writeStagedCodexCandidateManifest` then exited zero with manifest SHA-256
`e87429f39e1d69f79e1dd37305092e0102163344311b17c849ff95f261020a78`.
An independent `validateStagedCodexCandidate` call exited zero. Both ran
through `scripts/limited.ts`. The disposable cold-owner backend fixture was
run again against this stripped candidate CLI and exited zero: the cold read
made no tracked state change, owner-only resume preserved the saved settings,
the private follow-up completed and was saved, and the two model requests had
tool counts `[8, 0]`. This validates the stripped CLI in that fixture only.

The same candidate was copied into a private fake home at
`/var/tmp/orbit-codex-owner-dry-home`. A `0600` fake owner config pointed to
its complete pinned manifest. `prepareCodexOwnerLaunch` returned
`{"choice":"candidate","setEnvKeys":["CODEX_CLI_PATH","CODEX_LINUX_APP_DIR","CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET"]}`
without launching a process. Appending one byte to the copied
`sidebar-state-bridge.js` made the same dry run return
`{"choice":"original","setEnvKeys":[]}`. Restoring that file made the
candidate choice return. The test changed only the fake home copy.

The staged ASAR contains fixture viewer and composer hooks, and the CLI patch
is experimental. The owner was not launched through this candidate, no real
account was attached, and the public Orbit gate still denies saved content
and writes. The verifier also checks a same-user editable tree before a later
launch by path; that verification-to-execution interval has not been closed.
The candidate is a dry-run artifact, not a personal or public route.
