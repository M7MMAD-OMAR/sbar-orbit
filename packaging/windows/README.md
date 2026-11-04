# Windows desktop candidate

This source builds a real WinForms/WebView2 window, native tray menu, Start Menu shortcut, thin native launcher and per-user Inno Setup EXE. It is not a renamed source archive and does not implement Windows application control.

## Evidence and resources

Source and tiny packaging tests are not Windows acceptance. The manual workflow must restore locked packages, compile both EXEs, create and install the installer into its disposable runner root, and actually show the owned window. Evidence consists of the native handle/visibility report and screenshot of its own WebView surface, not another application or personal browser.

Heavy runner steps perform fresh CIM memory/CPU checks, use the existing Bun budget wrapper and limit .NET and compression parallelism to two. Reserve failure stops work, never kills unrelated processes. Local builds need a fresh preflight and Lead slot. A workflow is not proof of execution.

## Prerequisites and trust

Pinned official metadata: .NET SDK 10.0.403, runtime 10.0.14, Microsoft.Web.WebView2 1.0.4314.35 with official NuGet SHA-512, and Bun 1.4.4 with GitHub archive SHA-256. Metadata URLs are in build-pins.json. The thin launcher uses the Windows .NET Framework compiler/runtime; the build runner must provide Inno Setup. The versioned GUI is .NET self-contained.

WebView2 Evergreen must already be installed. Its documented Microsoft registry identity is checked. Missing runtime causes a friendly refusal, not a silent download or browser profile copy. WebView state belongs only to this application.

No signing certificate exists. Application and installer are unsigned and SmartScreen may warn. Hashes protect integrity inside the release-feed trust boundary, not independent publisher authenticity or same-user compromise.

## Managed update contract

Asset sbar-orbit-VERSION-windows-x64-desktop.zip contains only desktop/windows-app/**, runtime/bun.exe and desktop-manifest.json. Protocol 1 records the exact source revision/digest and every overlay file hash. The packager imports updater validation, not a competing manifest policy. The npm artifact remains source, never a fictional GUI binary.

On Windows the managed runtime root is %LOCALAPPDATA%/sbar-orbit/managed. Ordinary preferences, diagnostics, WebView state and workspaces stay in the parent application data area. Existing parent data is neither treated as a prepared runtime nor deleted; unknown contents or tasks in the new managed namespace still refuse admission. Linux layout and prepared-source-derived custom roots are unchanged.

The installer merges audited same-commit npm source, frozen offline production dependencies and the overlay. Only the central bootstrap owns admission, tasks, managed file installation and current pointer changes. Missing/incompatible GUI assets must defer the entire update, never activate CLI alone.

Stable Orbit.exe resolves the current canonical version and runtime hash, then invokes that verified version's central verifier before GUI/CLI launch. It never uses PATH Bun or an inherited old runtime pin. MCP preserves inherited streams.

Compatible protocol-1 GUI/CLI payload updates can activate automatically together. They never focus/open a new window or replace an existing window. A running old GUI may remain until normal user relaunch. Permanent bootstrap replacement is not silently automatic: an incompatible future protocol defers and requires an admitted installer upgrade.

The uninstall registration lives outside the managed root. Verified current code prepares an external maintenance copy; after the thin launcher exits, only that central copy removes admitted owned files/tasks. Refusal never kills a shared broker or bypasses active work.

## Publication

Public Actions artifacts contain only content-free reports, manifests and owned GUI screenshots. Setup EXEs, desktop ZIPs and bundled Bun payloads stay inside the disposable runner until vendor redistribution review clears. Runtime verification and publication readiness are separate; publicationReadiness remains false even when actual runtime checks pass. There is no invented download URL or claim that reliability-only 0.4.2 contains Windows EXEs. A follow-up requires actual Windows acceptance, vendor clearance and an honest signing status.

## Hosted compiled acceptance, not public-feed E2E

The dedicated hosted Windows job first downloads the pinned Bun ZIP, verifies its digest,
installs frozen source dependencies under the existing budget and performs a production
Windows IPC bind plus client doctor roundtrip. This happens before setup-dotnet downloads
an SDK. Failure stops the job. GITHUB_ACTIONS and Windows are required, and any preexisting
normal managed root is preserved and refuses the run. The root is computed by the actual
managedUpdateRoot API, not an assumed path or test platform override.

After real native builds, the installer refusal fixture checks the exact owned sentinel,
current pointer and shell/task snapshots. It then installs into the actual normal account
root. Two separately compiled next-patch prerelease GUI/native-host variants are explicitly
unpublished CI fixtures. Original publisher annotation bytes and hashes are preserved only
in outside evidence; no fake publisher receipt, source commit, public version or feed is
created. Fixture annotations are omitted from their runtime roots. The overlay source digest
binds the actual changed package/assembly metadata. The rollback-only variant explicitly
contains a sealed broker-start failure. These are offline activation fixtures, not 72-hour
registry eligibility, automatic selection or public GitHub/NPM delivery evidence.

The acceptance program initializes and pings the actual compiled stable Orbit.exe MCP
transport, records its real OS PID/image/start time, and keeps that exact initialized stdin
stream open across production activateVersion with defaults only. It checks actual task and
broker health, one current GUI/CLI/runtime version, mapped compatible host retention and old
source retention. The new GUI must really show its owned window and capture its own WebView
surface. Windows pruning remains disabled and removes nothing. After the old client exits,
a production failure/healthy-rollback cycle stops the broker under the normal barrier before
verifying host repair. There is no manual task kill, fake SID, lifecycle recorder or injected
health success. Finally the actual installed outside-root uninstaller and its maintenance
script must remove only their admitted owned files/tasks and preserve user data.

Maintenance module closure is audited in the actual NPM payload. Relative runtime imports
must exist and must not refer to excluded packaging files. The installer-only PowerShell
maintenance file is explicitly installed outside the managed root and verified there before
uninstall. It is not assumed to exist inside the NPM package.

## Third-party redistribution gate

The hosted build inventories and bundles actual license/notice files from the pinned .NET
Core/Desktop runtime and WebView2 NuGet packs, plus the digest-pinned upstream Bun 1.4.4
LICENSE.md. Missing vendor terms stop the build. These files are included in the overlay
manifest under the GUI third-party-notices tree. Orbit's license does not cover these vendors.

This inventory is not a declaration that every redistribution obligation has been satisfied.
[Bun's upstream terms](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.4/LICENSE.md)
state that Bun itself is MIT licensed but statically links LGPL-2 JavaScriptCore/WebCore and
describe relinking/source obligations. Review corresponding source/object/relinking delivery
and Microsoft WebView2 SDK/runtime terms before public redistribution. Candidate build
metadata deliberately marks that review pending. No actual Windows acceptance, signing or
vendor-compliance completion is claimed until the required evidence exists.
