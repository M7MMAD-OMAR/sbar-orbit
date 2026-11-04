# Windows runtime delivery v2 candidate

This source builds a real WinForms/WebView2 management window, tray menu, native launcher
and per-user Inno Setup installer. Windows original-application control is unsupported.
Source fixtures are not compiled Windows acceptance. Private protocol-1 runs established
actual Windows IPC and SDK setup, then exposed a NuGet hash mismatch before compilation.
They do not establish a GUI/installer success or protocol-2 acceptance.

## No Bun in public payloads

Protocol 2 uses desktop manifest schema 2. Public desktop ZIPs contain GUI/native helpers,
UI and vendor notices plus the manifest, with exactly the expected runtime/bun.exe hole.
Public Setup contains audited source, frozen production dependencies and that public GUI
payload. It contains neither Bun nor its archive, including renamed copies or a Bun-compiled
bootstrap. The packager accepts a descriptor, not a private runtime path. It hashes all
public inputs and rejects known runtime/archive bytes, archive containers and large
non-thin EXEs. Public staging and complete private validation are separate operations.

The .NET Framework C#5 initial helper runs without Bun. Setup requires an explicit download
checkbox, /ACCEPTBUNRUNTIMEDOWNLOAD=1, or an explicit /BUNRUNTIMEARCHIVE=PATH matching the
official pin. There is no descriptor boolean that grants consent. Normal launcher, GUI,
MCP and connector configuration paths never acquire a runtime or search PATH for one.

The helper verifies public source/GUI bytes, then downloads only the reconstructed official
Bun release over bounded HTTPS redirects, or copies the explicitly supplied official ZIP.
Archive and executable lengths and hashes, ZIP metadata/CRC/member/path/overlap bounds and
one five-minute acquisition deadline are enforced. Extraction writes only the pinned member
to a fresh private ACL-restricted stage. A descriptor-bound receipt is created and the full
private payload is checked before starting the verified Bun and central managed installer.
The helper never independently writes current or registers tasks. Unknown staging entries
are preserved rather than recursively cleaned. A failed acquisition cannot partially activate.

## Managed namespace and compatibility

The Windows runtime root is %LOCALAPPDATA%/sbar-orbit/managed. Preferences, diagnostics,
WebView data and workspaces remain in the parent application data area. Unknown managed
root contents and preexisting tasks still refuse admission. Linux layout and prepared-source
custom-root derivation are unchanged. No profile is copied and no unrelated process is killed.

Schema 2 requires bootstrap protocol 2. Private protocol-1 hosts cannot parse it and must
not be retained or silently upgraded across that boundary. Fresh public v2 adoption or an
explicit idle migration is required. Same-protocol-2 sharing violations can retain the
admitted old native host without closing idle MCP. The single current pointer still moves
source, GUI, CLI and verified runtime together. Windows pruning remains disabled before
any deletion, irrespective of origin metadata or a process census.

The public overlay also carries the exact publisher Windows production node_modules tree,
including all licenses and data. Its canonical SHA-256 TAB path LF dependency-files.tsv
is inside the hashed/sealed GUI prefix. Native shared C#5 validation checks that exact tree
before every Bun execution, including direct GUI and the current versioned native updater
host. Changed, missing, extra, redirected, hard-linked or case-conflicting files and unknown
empty directories refuse startup. Updates copy the validated bundle, never reinstall Windows
dependencies nondeterministically. Linux seal format and installation are unchanged.

Both native launcher and GUI attest the prepared source/runtime seal before executing any
TypeScript. Central current validation follows; stale GUI context refuses actions until a
normal user relaunch. Acquisition is separate from ordinary launch. Background updates do
not open or focus windows. An open old GUI can remain until user relaunch.

## Pinned tools and distinct NuGet hashes

The source pins .NET SDK 10.0.403, self-contained runtime 10.0.14, WebView2 SDK 1.0.4314.35
and official Bun 1.4.4. WebView2's raw signed NUPKG SHA-512 is not its signed NuGet content
hash. Actual isolated SDK verification and fresh locked restores in run 41755860193 qualified
both independently: build-pins retains the raw catalog hash and a separate nugetContentHash.
Production restore always remains locked with signature/hash verification enabled.

The production Bun descriptor uses actual private CI executable hash/size/member metadata,
plus the matching official archive hash and size. The separate shared synthetic conformance
fixture is never a production binary pin. Native and Node descriptor IDs use the same 13
ordered UTF-8 length-prefixed values, and receipts do not grant consent or capability.

WebView2 Evergreen remains an explicit prerequisite. Missing runtime causes a friendly
refusal, not a silent global download. Application and installer are unsigned; there is no
publisher certificate or signing claim. Hash checks establish integrity within the reviewed
release/upstream trust boundary, not independent publisher authentication.

## Hosted acceptance and publication gates

Only a dedicated hosted Windows CI account may run the acceptance driver. It refuses an
existing managed root and performs an actual private IPC/client doctor roundtrip before SDK
download. Memory/CPU/disk preflights and existing capped Bun jobs guard heavy steps. .NET
builds and compression use at most two workers. No local build is implied by these sources.

The job compiles actual native helpers and compares native descriptor/receipt conformance
against the shared Node fixture. Public packaging is audited before Setup compilation.
The refusal fixture uses its exact supplied archive, while successful Setup exercises
explicitly consented native upstream download. Actual compiled Orbit.exe MCP stdio is
initialized and kept open across production activation with no OS/SID/task/health recorders.
Two real compiled private next-patch fixtures distinguish offline activation/rollback from
public NPM/GitHub maturity or automatic feed-selection E2E evidence. Old MCP PID/start/Bun
children, broker doctor, native window/surface screenshot, healthy rollback, host repair
under the production stop barrier and actual outside-root uninstaller are checked.
Conversation off is never overridden or repaired by the fixture.

Public Actions uploads remain metadata/manifests and owned GUI screenshots only. Setup EXEs,
ZIPs and private runtime payloads are never uploaded while publicationReadiness is false.
A runtimeVerified verdict is separate from public readiness. No hypothetical Windows download
URL or claim that reliability-only 0.4.2 contains native Windows artifacts is made.

.NET/WebView2/dependency notices are inventoried from actual pinned package output and bundled;
missing terms stop the build. Bun's pinned upstream license text is delivered under the GUI
notices/bun directory, without redistributing its engine. Orbit's license does not cover
vendors, and direct acquisition does not certify all other redistribution conditions. Public
binary delivery stays blocked until actual v2 acceptance and the vendor/no-runtime inspection
have passed. No fabricated source offer, profile substitute or native-control claim is made.
