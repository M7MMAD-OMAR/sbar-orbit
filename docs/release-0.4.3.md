# Orbit 0.4.3 source candidate

This is a source candidate, not a published or Windows-runtime-verified release. Hosted Windows evidence confirms real IPC, verified NuGet restore and a v1 GUI compile/publish. The revised v2 native launcher, installed application, interactive logon task, visible GUI and version-transition acceptance remain separate pending gates. There is no Windows download link here. The separately published 0.4.2 GitHub release, npm package and website do not contain this Windows desktop application; that immutable release is not being relabeled.

## Windows application source

The candidate implements a WinForms/WebView2 application on .NET 10, a native tray menu, a Start Menu shortcut, a thin native launcher and a per-user Inno Setup EXE. The versioned GUI is self-contained. Public Setup and update artifacts omit Bun; explicit installer consent or a matching supplied official archive acquires the pinned private runtime directly from its publisher. A verified private cache or bounded upstream download supplies later runtime updates. Source, GUI, exact sealed production dependencies and runtime must all be complete before activation. This is desktop application and installer source, not a source archive renamed to an EXE. Successful compilation or installation is not asserted by these notes.

WebView2 Evergreen must already be installed. Missing runtime produces a friendly refusal, not a silent system-wide download. The application uses its own WebView state, not a copied personal browser profile. See the [Windows candidate contract](../packaging/windows/README.md).

Initial managed adoption requires a fresh per-user runtime root at `%LOCALAPPDATA%/sbar-orbit/managed` and proved absence of the previous broker task and endpoint. Ordinary application state and workspaces remain in the parent and are not deleted to manufacture freshness. Unknown or unmanaged state is preserved and refused rather than guessed stopped. An identical existing installation is reusable only after admission, task identity and actual broker health checks. Legacy source-only Windows adoption is not a substitute for the complete desktop installer.

## One versioned GUI, CLI and runtime payload

Automatic discovery selects a newer same-line npm release after the existing 72-hour maturation delay. Windows additionally requires its matching fixed-repository GitHub desktop overlay, mature release/asset metadata, published SHA-256, exact version and source identity, bounded manifest and file hashes. Missing or incompatible desktop artifacts defer the whole update; the CLI is not activated alone. These checks establish integrity within the publishing-feed trust boundary, not independent publisher authenticity.

The overlay contract is:

```text
sbar-orbit-VERSION-windows-x64-desktop.zip
  desktop/windows-app/**
  node_modules/**
  desktop-manifest.json  # schema 2, bootstrap protocol 2, exact upstream runtime descriptor
```

The public overlay carries publisher-installed dependencies and their exact bounded inventory under the sealed desktop subtree. Native entry points must verify that complete tree before Bun executes; the Windows updater does not replace it with an unverified fresh install. The one permitted public runtime hole is filled and verified privately. Side-by-side prepared versions and one atomic current pointer select GUI, CLI, dependencies and runtime together. Activation retains idle/starting-work admission, owned-task/SID/runtime checks, exact broker identity health, rollback and persistent recovery barriers. Uncertain stop or health evidence never counts as successful activation. Existing automatic-update off preferences remain off; first-install automatic updates require the visible installer choice.

The stable MCP command uses the admitted native host rather than pinning a version directory or Bun executable:

```text
ROOT/bin/Orbit.exe --cli ROOT mcp
```

It is generated only from validated managed source and bootstrap provenance, not an arbitrary EXE name or environment hint. Existing MCP streams can keep a compatible protocol-2 host mapped. A sharing violation retains that verified host and its sealed origin while the current GUI/CLI/runtime payload advances. Replacement can be attempted again at a later admitted activation or repair once users release it; clients are not force-closed. An incompatible bootstrap protocol defers and needs an explicit admitted installer upgrade. This is not a promise of immediate replacement of every loaded component. A running GUI or adapter keeps its loaded version until normal relaunch or reconnect.

## Cleanup, uninstall and trust limits

**Windows version pruning is disabled before any deletion. All versions are retained.** Neither bootstrap-origin pins nor a read-only process census prove whole-directory quiescence. Cleanup requires a future kernel-qualified gate. Automatic updating does not prune; allow disk space for retained payloads. Linux pruning behavior is unchanged.

Uninstall is a separate explicit, guarded operation. Its registration lives outside the managed root. Verified code prepares a private external maintenance copy so loaded launcher/runtime files are not deleted in place. Only central maintenance may remove admitted owned tasks and inventoried files; active work, unknown ownership or changed files cause refusal. User data is preserved. Real installed uninstall and failure recovery still require Windows acceptance.

No Authenticode signing or trusted-publisher result is claimed. The candidate has no signing certificate and unsigned application/installer artifacts may trigger SmartScreen warnings. Do not disable SmartScreen, antivirus or other security controls. Hash verification is not code signing. See the dated [signing decision](windows-signing.md); its shipping-status statements describe that earlier recorded release state.

## Evidence and remaining gates

Before the additional dependency-seal review, full strict TypeScript and **513 source tests passed, 5 skipped, 0 failed, with 2107 assertions across 58 files**. Website typechecking, 10 tests and the candidate build passed; isolated English/Arabic previews at 1280 and 375 pixels had no horizontal overflow and were not deployed. The dependency execution gap found during review adds mandatory tests and a fresh verification gate. These source fixtures are not installed application, focus/pointer, MCP survival or automatic-update acceptance. Dated [Windows evidence](windows-desktop-acceptance-2026-11-04.json) keeps successful substeps separate from failed overall runs.

The Windows CI acceptance work must exercise the actual compiled host, initialized MCP stdio, real broker IPC and SID-owned task, coherent version activation with a mapped compatible host, and new-version CLI/GUI resolution. An owned unpublished offline candidate can test activation but must be labeled as such, not as a verified npm/GitHub rollout. Actual visible GUI, installation, rollback, lifecycle and uninstall outcomes must be recorded separately. A workflow or successful source test is not evidence that those operations ran.

**Windows original-application native control remains unsupported.** This is adapter readiness, not a browser or terminal category ban. The application frontend does not supply a Windows UI Automation/capture/input backend. Public accessibility refs and semantic writes are not enabled by this candidate. No cross-platform native parity, measured latency/token savings, or 80% efficiency result is claimed.
